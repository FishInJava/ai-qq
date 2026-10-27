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

/**
 * 起一个真实进程：临时 DATA_DIR + 配置端口 0（系统分配）。
 * 返回的 baseUrl 可直接用于 fetch。
 *
 * @param {{ config?: object, dataDir?: string, keepData?: boolean }} [options]
 */
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
      } catch {
        // 文件正在写入，下一轮再读。
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

  // runtime.json 会先于 stdout 的 data 事件出现（文件系统 vs pipe + 事件循环）。
  // 并发跑全量时这里会抢跑，output() 拿到空串，t17 就红。给它一拍。
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
