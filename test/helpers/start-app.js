import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const START_TIMEOUT_MS = 3000;
const STOP_TIMEOUT_MS = 1500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startApp({ config = {}, dataDir: existingDir = null, keepData = false } = {}) {
  const dataDir = existingDir ?? mkdtempSync(path.join(tmpdir(), 'companion-test-'));
  const fileConfig = {
    ...config,
    server: { port: 0, ...(config.server ?? {}) },
  };
  rmSync(path.join(dataDir, 'runtime.json'), { force: true });
  writeFileSync(
    path.join(dataDir, 'config.json'),
    `${JSON.stringify(fileConfig, null, 2)}\n`,
    'utf8',
  );

  let outputText = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, COMPANION_DISABLE_SHELL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => {
    outputText += chunk;
  });
  child.stderr.on('data', (chunk) => {
    outputText += chunk;
  });

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const runtimePath = path.join(dataDir, 'runtime.json');
  const deadline = Date.now() + START_TIMEOUT_MS;
  let runtime = null;

  while (Date.now() < deadline) {
    if (existsSync(runtimePath)) {
      try {
        runtime = JSON.parse(readFileSync(runtimePath, 'utf8'));
        break;
      } catch (error) {
        void error;
      }
    }
    if (child.exitCode !== null) {
      break;
    }
    await delay(25);
  }

  if (!runtime) {
    child.kill();
    await Promise.race([exited, delay(STOP_TIMEOUT_MS)]);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw new Error(`应用没有在 ${START_TIMEOUT_MS}ms 内启动。\n${outputText}`);
  }

  if (runtime) {
    const outputDeadline = Date.now() + 200;
    while (outputText.length === 0 && child.exitCode === null && Date.now() < outputDeadline) {
      await delay(10);
    }
  }

  return {
    dataDir,
    port: runtime.port,
    baseUrl: `http://127.0.0.1:${runtime.port}`,
    child,
    output: () => outputText,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const stopped = await Promise.race([exited, delay(STOP_TIMEOUT_MS).then(() => null)]);
        if (stopped === null && child.exitCode === null) {
          child.kill('SIGKILL');
          await Promise.race([exited, delay(STOP_TIMEOUT_MS)]);
        }
      }
      if (!keepData) {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  };
}
