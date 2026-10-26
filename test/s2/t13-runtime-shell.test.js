import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClock } from '../../src/clock/index.js';
import {
  buildStartupScript,
  disable,
  enable,
  readStartupScript,
  status,
  sync,
} from '../../src/runtime/autostart.js';
import { createLog } from '../../src/runtime/log.js';

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'companion-s2-shell-'));
}

test('非 Windows 上自启是明确的 no-op，不写系统也不写脚本', () => {
  const dir = tempDir();
  try {
    const before = status({ dataDir: dir, platform: 'linux' });
    assert.deepEqual(before, { supported: false, enabled: false, reason: 'not_windows' });
    assert.deepEqual(enable({ dataDir: dir, projectRoot: '/tmp/app', platform: 'linux' }), {
      supported: false,
      enabled: false,
      reason: 'not_windows',
    });
    assert.deepEqual(disable({ dataDir: dir, platform: 'linux' }), {
      supported: false,
      enabled: false,
      reason: 'not_windows',
    });
    assert.equal(readStartupScript(dir), null);
    assert.equal(existsSync(path.join(dir, 'autostart.cmd')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自启脚本自带 DATA_DIR 与工作目录，避免开机时找错库', () => {
  const script = buildStartupScript({
    projectRoot: 'C:\\App\\Companion',
    dataDir: 'C:\\Users\\HBZ\\AppData\\Roaming\\Companion data',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  });
  assert.match(script, /^@echo off/);
  assert.match(script, /set "DATA_DIR=C:\\Users\\HBZ\\AppData\\Roaming\\Companion data"/);
  assert.match(script, /cd \/d "C:\\App\\Companion"/);
  assert.match(script, /"C:\\Program Files\\nodejs\\node\.exe" --disable-warning=ExperimentalWarning "C:\\App\\Companion[\\/]src[\\/]index\.js"/);
  assert.match(script, /\r\n/);
});

test('测试环境禁用时 sync 不碰注册表，但仍报告支持的平台', () => {
  const result = sync({
    dataDir: tempDir(),
    projectRoot: '/tmp/app',
    enabled: true,
    platform: 'win32',
    disabled: true,
  });
  assert.deepEqual(result, { supported: true, enabled: false, reason: 'disabled' });
});

test('日志超过 10MB 轮转为 .1，启动时清掉 7 天前的旧文件', () => {
  const dir = tempDir();
  try {
    mkdirSync(path.join(dir, 'logs'), { recursive: true });
    writeFileSync(path.join(dir, 'logs', 'app-20200101.log'), 'old\n', 'utf8');
    const clock = createClock({ now: () => new Date(2026, 9, 26, 12, 0, 0).getTime() });
    const log = createLog({ dataDir: dir, clock });
    assert.equal(existsSync(path.join(dir, 'logs', 'app-20200101.log')), false);

    const chunk = 'x'.repeat(1024 * 1024);
    for (let index = 0; index < 11; index += 1) {
      log.info('large', { chunk });
    }
    const current = path.join(dir, 'logs', 'app-20261026.log');
    assert.equal(existsSync(current), true);
    assert.equal(existsSync(`${current}.1`), true);
    assert.ok(readFileSync(`${current}.1`, 'utf8').length > 10 * 1024 * 1024);
    log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('托盘与守护脚本包含打开页面、暂停、退出、42 退出码与每小时三次节流', () => {
  const root = new URL('../..', import.meta.url);
  const tray = readFileSync(new URL('src/runtime/tray.ps1', root), 'utf8');
  const supervisor = readFileSync(new URL('tools/run-companion.ps1', root), 'utf8');

  assert.match(tray, /NotifyIcon/);
  assert.match(tray, /打开页面/);
  assert.match(tray, /暂停所有会话/);
  assert.match(tray, /退出/);
  assert.match(tray, /Start-Process/);
  assert.match(tray, /pause-all/);
  assert.match(tray, /quit/);
  assert.match(tray, /runtime\.json/);

  assert.match(supervisor, /src\/index\.js/);
  assert.match(supervisor, /\$code -ne 42/);
  assert.match(supervisor, /AddHours\(-1\)/);
  assert.match(supervisor, /-ge 3/);
});
