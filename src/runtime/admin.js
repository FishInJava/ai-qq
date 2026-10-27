import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors.js';

export function createAdminService({
  store,
  clock,
  session,
  bus,
  dataDir,
  log,
  onQuit,
}) {
  let quitting = false;

  function pauseAll() {
    const count = session.pauseAll();
    log?.info('admin_pause_all', { paused: count });
    return { paused: count };
  }

  function purge() {
    const stamp = clock.iso().replaceAll(':', '-').replaceAll('.', '-');
    const backupName = `companion.backup-${stamp}.db`;
    const backupPath = path.join(dataDir, backupName);

    try {
      mkdirSync(dataDir, { recursive: true });
      store.backupTo(backupPath);
    } catch (err) {
      log?.error('admin_purge_backup_failed', { message: err?.message ?? String(err) });
      throw new AppError('purge_backup_failed', '清空前备份失败，数据没有改动', {
        status: 500,
        cause: err,
      });
    }

    try {
      store.tx(() => {
        store.purgeAll();
      });
      for (const dir of ['cards', 'avatars']) {
        rmSync(path.join(dataDir, dir), { recursive: true, force: true });
      }
    } catch (err) {
      log?.error('admin_purge_failed', {
        message: err?.message ?? String(err),
        backup: backupName,
      });
      throw new AppError('purge_failed', '数据没能清空，备份已保留', {
        status: 500,
        cause: err,
      });
    }

    log?.info('admin_purge', { backup: backupName });
    bus.emit('import', { reason: 'purge' });
    return { ok: true, backup: backupName };
  }

  function quit() {
    if (quitting) {
      return;
    }
    quitting = true;
    log?.info('admin_quit', {});
    clock.setTimer(() => {
      void Promise.resolve(onQuit()).catch((err) => {
        log?.warn('admin_quit_failed', { message: err?.message ?? String(err) });
      });
    }, 30);
  }

  return { pauseAll, purge, quit };
}
