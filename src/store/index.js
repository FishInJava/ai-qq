import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../errors.js';
import * as adminRepo from './repo/admin.js';
import * as budgetRepo from './repo/budget.js';
import * as charactersRepo from './repo/characters.js';
import * as factsRepo from './repo/facts.js';
import * as lifeEventsRepo from './repo/life-events.js';
import * as messagesRepo from './repo/messages.js';
import * as proactiveLogRepo from './repo/proactive-log.js';
import * as schedulerStateRepo from './repo/scheduler-state.js';
import * as sessionsRepo from './repo/sessions.js';
import * as summariesRepo from './repo/summaries.js';
import * as tokenLedgerRepo from './repo/token-ledger.js';
import * as worldFeedsRepo from './repo/world-feeds.js';
import { deleteHandle, getHandle, setHandle } from './handle.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const MIGRATION_FILE = /^(\d{4})-[a-z0-9-]+\.sql$/;

function backupCorruptDatabase({ dbPath, clock, log }) {
  const stamp = clock.iso().replaceAll(':', '-').replaceAll('.', '-');
  const backupPath = path.join(path.dirname(dbPath), `companion.corrupt-${stamp}.db`);
  try {
    renameSync(dbPath, backupPath);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) {
        renameSync(`${dbPath}${suffix}`, `${backupPath}${suffix}`);
      }
    }
    log?.error('db_corrupt_backup', { backupPath });
  } catch (err) {
    log?.error('db_corrupt_backup_failed', { message: err.message });
  }
  return backupPath;
}

/**
 * 打开 SQLite、设置 PRAGMA、返回 store 门面。
 * 业务模块只能通过 repo 读写，拿不到 db 句柄。
 *
 * @param {{ dataDir: string, clock: import('../clock/index.js').Clock, log?: object }} options
 */
export function openStore({ dataDir, clock, log }) {
  if (!dataDir) {
    throw new AppError('store_no_data_dir', '缺少数据目录', { status: 500 });
  }

  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'companion.db');
  const existed = existsSync(dbPath);
  let db;

  try {
    db = new DatabaseSync(dbPath);
  } catch (err) {
    throw new AppError('db_open_failed', '数据库打不开，请检查数据目录权限', { cause: err });
  }

  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');

    if (existed) {
      const row = db.prepare('PRAGMA integrity_check').get();
      if (!row || row.integrity_check !== 'ok') {
        db.close();
        const backupPath = backupCorruptDatabase({ dbPath, clock, log });
        throw new AppError(
          'db_corrupt',
          `数据库损坏，已备份到 ${path.basename(backupPath)}，请检查后重启`,
          { status: 500 },
        );
      }
    }
  } catch (err) {
    try {
      db.close();
    } catch (closeErr) {
      log?.warn('db_close_failed', { message: closeErr.message });
    }
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError('db_open_failed', '数据库初始化失败，请稍后再试', { cause: err });
  }

  let inTransaction = false;

  const store = {
    dbPath,

    /** 顺序执行未应用的迁移，事务内完成。 */
    migrate() {
      const handle = getHandle(store);
      handle.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);
      const currentRow = handle.prepare('SELECT MAX(version) AS version FROM schema_version').get();
      const current = Number(currentRow?.version ?? 0);
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((file) => MIGRATION_FILE.test(file))
        .sort();

      for (const file of files) {
        const version = Number(MIGRATION_FILE.exec(file)[1]);
        if (version <= current) {
          continue;
        }
        const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        handle.exec('BEGIN IMMEDIATE');
        try {
          handle.exec(sql);
          handle.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)')
            .run(version, clock.iso());
          handle.exec('COMMIT');
          log?.info('db_migrated', { version, file });
        } catch (err) {
          try {
            handle.exec('ROLLBACK');
          } catch (rollbackErr) {
            log?.warn('db_rollback_failed', { message: rollbackErr.message });
          }
          throw new AppError('db_migration_failed', `数据库迁移失败（${file}）`, { cause: err });
        }
      }
    },

    /**
     * 写事务唯一入口。禁止嵌套。
     *
     * @template T
     * @param {() => T} fn
     * @returns {T}
     */
    tx(fn) {
      if (inTransaction) {
        throw new AppError('store_nested_tx', '数据库事务不能嵌套', { status: 500 });
      }
      const handle = getHandle(store);
      handle.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      try {
        const result = fn();
        handle.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          handle.exec('ROLLBACK');
        } catch (rollbackErr) {
          log?.warn('db_rollback_failed', { message: rollbackErr.message });
        }
        throw err;
      } finally {
        inTransaction = false;
      }
    },

    /**
     * 只读包装。当前不强制快照，保留给后续查询使用。
     *
     * @template T
     * @param {() => T} fn
     * @returns {T}
     */
    read(fn) {
      return fn();
    },

    close() {
      const handle = getHandle(store);
      handle.close();
      deleteHandle(store);
    },
  };

  store.characters = {
    findByHash: (hash) => charactersRepo.findByHash(store, hash),
    findById: (id) => charactersRepo.findById(store, id),
    insert: (card) => charactersRepo.insert(store, card),
    update: (id, card) => charactersRepo.update(store, id, card),
    remove: (id) => charactersRepo.remove(store, id),
  };
  store.sessions = {
    insert: (session) => sessionsRepo.insert(store, session),
    findById: (id) => sessionsRepo.findById(store, id),
    findByCharacterId: (characterId) => sessionsRepo.findByCharacterId(store, characterId),
    listWithCharacters: (options) => sessionsRepo.listWithCharacters(store, options),
    listAll: () => sessionsRepo.listAll(store),
    start: (id, tokenLimit) => sessionsRepo.start(store, id, tokenLimit),
    setState: (id, state) => sessionsRepo.setState(store, id, state),
    setTokenLimit: (id, tokenLimit) => sessionsRepo.setTokenLimit(store, id, tokenLimit),
    setPauseGap: (id, hours) => sessionsRepo.setPauseGap(store, id, hours),
    markUserMessage: (id, at) => sessionsRepo.markUserMessage(store, id, at),
    markProactive: (id, at) => sessionsRepo.markProactive(store, id, at),
    setHardDedup: (id, at) => sessionsRepo.setHardDedup(store, id, at),
    silenceColdStart: () => sessionsRepo.silenceColdStart(store),
    silenceColdStartFor: (id) => sessionsRepo.silenceColdStartFor(store, id),
    bumpIgnored: (id) => sessionsRepo.bumpIgnored(store, id),
    addTokens: (id, amount) => sessionsRepo.addTokens(store, id, amount),
    setQuotaFlag: (id, flagged) => sessionsRepo.setQuotaFlag(store, id, flagged),
    remove: (id) => sessionsRepo.remove(store, id),
  };
  store.messages = {
    lastForSession: (sessionId) => messagesRepo.lastForSession(store, sessionId),
    lastCreatedAtForRole: (sessionId, role) => messagesRepo.lastCreatedAtForRole(store, sessionId, role),
    listForSession: (sessionId, options) => messagesRepo.listForSession(store, sessionId, options),
    listByIds: (sessionId, ids) => messagesRepo.listByIds(store, sessionId, ids),
    listAfter: (sessionId, afterId) => messagesRepo.listAfter(store, sessionId, afterId),
    insert: (message) => messagesRepo.insert(store, message),
  };
  store.facts = {
    listPending: (sessionId, limit) => factsRepo.listPending(store, sessionId, limit),
    findActive: (sessionId, subject, key) => factsRepo.findActive(store, sessionId, subject, key),
    findById: (id) => factsRepo.findById(store, id),
    insert: (fact) => factsRepo.insert(store, fact),
    close: (id, at) => factsRepo.close(store, id, at),
    touch: (id, at) => factsRepo.touch(store, id, at),
    markDone: (id) => factsRepo.markDone(store, id),
    listAll: (sessionId) => factsRepo.listAll(store, sessionId),
    search: (sessionId, pattern, limit) => factsRepo.search(store, sessionId, pattern, limit),
    remove: (id) => factsRepo.remove(store, id),
  };
  store.summaries = {
    listRecent: (sessionId, limit) => summariesRepo.listRecent(store, sessionId, limit),
    lastForSession: (sessionId) => summariesRepo.lastForSession(store, sessionId),
    listAll: (sessionId) => summariesRepo.listAll(store, sessionId),
    insert: (summary) => summariesRepo.insert(store, summary),
    search: (sessionId, pattern, limit) => summariesRepo.search(store, sessionId, pattern, limit),
  };
  store.lifeEvents = {
    listForDay: (sessionId, day) => lifeEventsRepo.listForDay(store, sessionId, day),
    listUnusedForDay: (sessionId, day) => lifeEventsRepo.listUnusedForDay(store, sessionId, day),
    countForDay: (sessionId, day) => lifeEventsRepo.countForDay(store, sessionId, day),
    insert: (event) => lifeEventsRepo.insert(store, event),
    markUsed: (id, messageId) => lifeEventsRepo.markUsed(store, id, messageId),
  };
  store.worldFeeds = {
    listForDay: (day) => worldFeedsRepo.listForDay(store, day),
    insertIfAbsent: (feed) => worldFeedsRepo.insertIfAbsent(store, feed),
    removeBefore: (cutoffDay) => worldFeedsRepo.removeBefore(store, cutoffDay),
  };
  store.proactiveLog = {
    insert: (entry) => proactiveLogRepo.insert(store, entry),
    listRecent: (sessionId, limit) => proactiveLogRepo.listRecent(store, sessionId, limit),
  };
  store.schedulerState = {
    insert: (entry) => schedulerStateRepo.insert(store, entry),
    listRecent: (sessionId, limit) => schedulerStateRepo.listRecent(store, sessionId, limit),
    countSince: (sessionId, sinceIso) => schedulerStateRepo.countSince(store, sessionId, sinceIso),
  };
  store.tokenLedger = {
    insert: (entry) => tokenLedgerRepo.insert(store, entry),
    listForSession: (sessionId, limit) => tokenLedgerRepo.listForSession(store, sessionId, limit),
    listRange: (fromIso, toIso) => tokenLedgerRepo.listRange(store, fromIso, toIso),
    lastRefillAt: (sessionId) => tokenLedgerRepo.lastRefillAt(store, sessionId),
  };
  store.backupTo = (targetPath) => adminRepo.backupTo(store, targetPath);
  store.purgeAll = () => adminRepo.purgeAll(store);
  store.budget = {
    usedOn: (date, sessionId) => budgetRepo.usedOn(store, date, sessionId),
    globalUsedOn: (date) => budgetRepo.globalUsedOn(store, date),
    increment: (date, sessionId, amount) => budgetRepo.increment(store, date, sessionId, amount),
  };

  setHandle(store, db);
  return store;
}
