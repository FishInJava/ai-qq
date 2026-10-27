import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const START_TIMEOUT_MS = 3000;
const STOP_TIMEOUT_MS = 1500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startFakeLlm() {
  const child = spawn(process.execPath, ['tools/fake-llm/server.js', '--port', '0'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  let port = null;

  while (Date.now() < deadline) {
    const match = /fake-llm listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) {
      port = Number(match[1]);
      break;
    }
    if (child.exitCode !== null) {
      break;
    }
    await delay(25);
  }

  if (port === null) {
    child.kill();
    await Promise.race([exited, delay(STOP_TIMEOUT_MS)]);
    throw new Error(`假 LLM 没有启动。\n${output}`);
  }

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    async stats() {
      const response = await fetch(`http://127.0.0.1:${port}/__stats`);
      return response.json();
    },
    async lastRequest() {
      const response = await fetch(`http://127.0.0.1:${port}/__last`);
      const body = await response.json();
      return body.request;
    },
    async lastStreamRequest() {
      const response = await fetch(`http://127.0.0.1:${port}/__last-stream`);
      const body = await response.json();
      return body.request;
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const stopped = await Promise.race([exited, delay(STOP_TIMEOUT_MS).then(() => null)]);
        if (stopped === null && child.exitCode === null) {
          child.kill('SIGKILL');
          await Promise.race([exited, delay(STOP_TIMEOUT_MS)]);
        }
      }
    },
  };
}
