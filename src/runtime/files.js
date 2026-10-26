import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));

/** @returns {string} */
export function readVersion() {
  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
  return String(pkg.version ?? '0.0.0');
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function runtimeFilePath(dataDir) {
  return path.join(dataDir, 'runtime.json');
}

/**
 * 端口与 pid 的落盘位置，托盘与冒烟脚本据此找到服务。
 *
 * @param {{ dataDir: string, port: number, clock: import('../clock/index.js').Clock }} options
 */
export function writeRuntimeFile({ dataDir, port, clock }) {
  mkdirSync(dataDir, { recursive: true });
  const target = runtimeFilePath(dataDir);
  const tmp = `${target}.tmp-${process.pid}`;
  const payload = {
    port,
    pid: process.pid,
    started_at: clock.iso(),
  };
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, target);
  } catch {
    writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    rmSync(tmp, { force: true });
  }
}

/** @param {string} dataDir */
export function removeRuntimeFile(dataDir) {
  rmSync(runtimeFilePath(dataDir), { force: true });
}

/** @param {string} dataDir */
export function runtimeFileExists(dataDir) {
  return existsSync(runtimeFilePath(dataDir));
}
