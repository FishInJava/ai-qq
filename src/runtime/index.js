import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCards } from '../cards/index.js';
import { createChat } from '../chat/index.js';
import { systemClock } from '../clock/index.js';
import { createHttp } from '../http/index.js';
import { createLibrary } from '../library/index.js';
import { createFeeds } from '../living/feeds.js';
import { createLiving } from '../living/index.js';
import { createLlm } from '../llm/index.js';
import { createMemory } from '../memory/index.js';
import { createProactive } from '../proactive/index.js';
import { createQuota } from '../quota/index.js';
import { createSchedule } from '../schedule/index.js';
import { createSessionService } from '../session/state.js';
import { createStyle } from '../style/index.js';
import { createBus } from './bus.js';
import { createAdminService } from './admin.js';
import { sync as syncAutostart } from './autostart.js';
import { createConfigService, loadConfig } from './config.js';
import { readVersion, removeRuntimeFile, writeRuntimeFile } from './files.js';
import { acquireLock } from './lock.js';
import { createLog } from './log.js';
import { openStore } from '../store/index.js';

/**
 * 组合根：按 ARCHITECTURE §D-14 的启动顺序装配。
 * 当前包含配置 → 日志 → 单实例锁 → 数据库 → 卡片/角色库/会话状态 → HTTP；调度器与托盘在后续里程碑接上。
 *
 * @param {{ dataDir?: string }} [options]
 */
export async function start({ dataDir } = {}) {
  const dir = path.resolve(dataDir ?? process.env.DATA_DIR ?? 'data');
  const clock = systemClock;
  const startedAt = clock.now();
  const { config, configPath } = loadConfig({ dataDir: dir });
  const log = createLog({ dataDir: dir, clock });

  let lock;
  let store;
  let bus;
  let http;
  let cards;
  let library;
  let quota;
  let sessionService;
  let style;
  let llm;
  let memory;
  let living;
  let chat;
  let proactive;
  let schedule;
  let configService;
  let admin;
  let tray = null;
  let stopping = false;
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
  const shellDisabled = process.env.COMPANION_DISABLE_SHELL === '1';

  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    if (tray) {
      try {
        tray.kill();
      } catch (err) {
        log.warn('tray_stop_failed', { message: err.message });
      }
      tray = null;
    }
    try {
      schedule?.stop();
    } catch (err) {
      log.warn('schedule_stop_failed', { message: err.message });
    }
    try {
      await http?.stop();
    } finally {
      try {
        bus?.close();
      } catch (err) {
        log.warn('bus_close_failed', { message: err.message });
      }
      try {
        store?.close();
      } catch (err) {
        log.warn('store_close_failed', { message: err.message });
      }
      try {
        lock?.release();
      } catch (err) {
        log.warn('lock_release_failed', { message: err.message });
      }
      removeRuntimeFile(dir);
      log.info('app_stop', {});
      log.close();
    }
  };

  try {
    lock = acquireLock({ dataDir: dir, clock, log });
    store = openStore({ dataDir: dir, clock, log });
    store.migrate();

    bus = createBus({
      onError: (err, topic) => {
        log.error('bus_listener_failed', { topic, message: err.message });
      },
    });

    const version = readVersion();
    configService = createConfigService({ config, configPath, log });
    quota = createQuota({ store, clock, config });
    cards = createCards({ store, clock, config, dataDir: dir, bus, log });
    library = createLibrary({ store, quota });
    sessionService = createSessionService({ store, clock, config, quota, bus, log });
    style = createStyle();
    llm = createLlm({ config, clock, log });
    memory = createMemory({ store, clock, llm, log });
    living = createLiving({
      store,
      clock,
      llm,
      feeds: createFeeds({ store, clock, config, log }),
      log,
    });
    chat = createChat({ store, clock, config, llm, style, quota, session: sessionService, memory, bus, log });
    proactive = createProactive({ store, clock, config, llm, style, quota, bus, log });
    schedule = createSchedule({
      store,
      clock,
      config,
      proactive,
      living,
      session: sessionService,
      bus,
      log,
    });
    admin = createAdminService({
      store,
      clock,
      session: sessionService,
      bus,
      dataDir: dir,
      log,
      onQuit: stop,
    });
    http = createHttp({
      config,
      clock,
      log,
      bus,
      version,
      startedAt,
      cards,
      library,
      session: sessionService,
      chat,
      memory,
      living,
      schedule,
      quota,
      configService,
      admin,
    });
    const { port } = await http.start();
    schedule.start();
    writeRuntimeFile({ dataDir: dir, port, clock });

    // 服务只绑 127.0.0.1（见 http 模块），给用户一行能直接在浏览器打开的地址；
    // 用实际监听端口：端口 0 自动分配、或被占用递增时也不会指错地方。
    // 组合根是全项目唯一写 stdout 的位置（tools/check.js 已豁免 runtime）。
    process.stdout.write(`她已经醒着了，打开页面：http://127.0.0.1:${port}\n`);
    const autostartState = syncAutostart({
      dataDir: dir,
      projectRoot,
      enabled: config.runtime.autostart !== false,
      disabled: shellDisabled,
      log,
    });
    log.info('autostart_synced', autostartState);

    if (process.platform === 'win32' && !shellDisabled) {
      try {
        tray = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(projectRoot, 'src', 'runtime', 'tray.ps1'),
            path.join(dir, 'runtime.json'),
          ],
          { stdio: 'ignore', windowsHide: true },
        );
        tray.once('error', (err) => {
          log.warn('tray_start_failed', { message: err.message });
        });
        tray.once('exit', (code, signal) => {
          log.warn('tray_exited', { code, signal });
          tray = null;
        });
        tray.unref();
        log.info('tray_started', { pid: tray.pid });
      } catch (err) {
        log.warn('tray_start_failed', { message: err.message });
      }
    }

    log.info('app_start', { version, port, sessions_restored: 0 });
    log.event('app_start', { version, port, sessions_restored: 0 });

    const fatal = (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('fatal', { message: error.message, stack: error.stack });
      void stop().finally(() => process.exit(42));
    };
    process.once('uncaughtException', fatal);
    process.once('unhandledRejection', fatal);

    const onSignal = () => {
      void stop().finally(() => process.exit(0));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    return {
      port,
      dataDir: dir,
      config,
      clock,
      log,
      store,
      bus,
      http,
      cards,
      library,
      quota,
      session: sessionService,
      style,
      llm,
      memory,
      living,
      chat,
      proactive,
      schedule,
      configService,
      admin,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
