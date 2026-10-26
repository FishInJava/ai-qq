import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors.js';

function readLock(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    return parsed && Number.isInteger(parsed.pid) ? parsed : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      return false;
    }
    // EPERM 说明进程存在但当前用户无权发信号；其他错误保守地当作活着。
    return true;
  }
}

/**
 * 单实例锁：pid + started_at。进程不存在时视为陈旧锁并清理。
 *
 * @param {{ dataDir: string, clock: import('../clock/index.js').Clock, log?: object }} options
 */
export function acquireLock({ dataDir, clock, log }) {
  const lockPath = path.join(dataDir, 'companion.lock');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, started_at: clock.iso() })}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      return {
        path: lockPath,
        release() {
          const current = readLock(lockPath);
          if (current?.pid === process.pid) {
            try {
              unlinkSync(lockPath);
            } catch (err) {
              log?.warn('lock_release_failed', { message: err.message });
            }
          }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw new AppError('lock_failed', '无法创建单实例锁，请检查数据目录权限', { cause: err });
      }
      const existing = readLock(lockPath);
      if (existing && isProcessAlive(existing.pid)) {
        throw new AppError('already_running', `已经在运行（pid ${existing.pid}）`, { status: 409 });
      }
      log?.warn('lock_stale_removed', { pid: existing?.pid ?? null });
      try {
        unlinkSync(lockPath);
      } catch (unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') {
          throw new AppError('lock_failed', '无法清理陈旧的单实例锁', { cause: unlinkErr });
        }
      }
    }
  }

  throw new AppError('lock_failed', '无法取得单实例锁，请稍后再试', { status: 500 });
}
