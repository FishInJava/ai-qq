import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const START_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 1500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRuntime(dataDir, child, output) {
  const runtimePath = path.join(dataDir, 'runtime.json');
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(runtimePath)) {
      try {
        return JSON.parse(readFileSync(runtimePath, 'utf8'));
      } catch {
        // 文件正在写入，下一轮再读。
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`服务提前退出（code=${child.exitCode}）。\n${output()}`);
    }
    await delay(25);
  }
  throw new Error(`服务没有在 ${START_TIMEOUT_MS}ms 内启动。\n${output()}`);
}

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'companion-smoke-'));
  writeFileSync(
    path.join(dataDir, 'config.json'),
    `${JSON.stringify({ server: { port: 0 } }, null, 2)}\n`,
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

  try {
    const runtime = await waitForRuntime(dataDir, child, () => outputText);
    const response = await fetch(`http://127.0.0.1:${runtime.port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      throw new Error(`/health 返回 ${response.status}`);
    }
    const body = await response.json();
    if (body.ok !== true || body.port !== runtime.port) {
      throw new Error(`/health 响应不符合预期：${JSON.stringify(body)}`);
    }
    process.stdout.write(`smoke ok (port ${runtime.port})\n`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const stopped = await Promise.race([exited, delay(STOP_TIMEOUT_MS).then(() => null)]);
      if (stopped === null && child.exitCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exited, delay(STOP_TIMEOUT_MS)]);
      }
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
