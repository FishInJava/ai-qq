import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const DB_PATH = path.join(DATA_DIR, 'companion.db');

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function readLockPid() {
  try {
    const lock = JSON.parse(readFileSync(path.join(DATA_DIR, 'companion.lock'), 'utf8'));
    return Number.isInteger(lock.pid) ? lock.pid : null;
  } catch {
    return null;
  }
}

const confirmed = process.argv.includes('--yes');
const pid = readLockPid();

if (pid && isProcessAlive(pid)) {
  process.stderr.write(`服务似乎还在运行（pid ${pid}）。先停止服务，再执行 db:reset。\n`);
  process.exitCode = 1;
} else if (!existsSync(DB_PATH)) {
  process.stdout.write('没有可重置的数据库。\n');
} else if (!confirmed) {
  process.stderr.write(
    'db:reset 会删除本地数据库。确认后重新执行：npm run db:reset -- --yes\n',
  );
  process.exitCode = 1;
} else {
  const backupDir = path.join(DATA_DIR, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backupBase = path.join(backupDir, `companion-${stamp}.db`);

  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${DB_PATH}${suffix}`;
    if (existsSync(source)) {
      copyFileSync(source, `${backupBase}${suffix}`);
    }
  }

  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${DB_PATH}${suffix}`;
    if (existsSync(target)) {
      unlinkSync(target);
    }
  }

  process.stdout.write(`数据库已重置。备份在 ${path.relative(ROOT, backupBase)}\n`);
}
