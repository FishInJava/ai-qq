import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'ProactiveCompanion';
const SCRIPT_NAME = 'autostart.cmd';

function isWindows(platform) {
  return platform === 'win32';
}

function startupScriptPath(dataDir) {
  return path.join(dataDir, SCRIPT_NAME);
}

/**
 * 自启脚本必须自己带上数据目录与工作目录；否则开机时 cwd 是 system32，会建错库。
 *
 * @param {{ projectRoot: string, dataDir: string, nodePath: string }} options
 */
export function buildStartupScript({ projectRoot, dataDir, nodePath }) {
  const quoted = (value) => `"${String(value).replaceAll('"', '""')}"`;
  return [
    '@echo off',
    `set "DATA_DIR=${String(dataDir).replaceAll('"', '')}"`,
    `cd /d ${quoted(projectRoot)}`,
    `${quoted(nodePath)} --disable-warning=ExperimentalWarning ${quoted(path.join(projectRoot, 'src', 'index.js'))}`,
    '',
  ].join('\r\n');
}

function runReg(args) {
  execFileSync('reg.exe', args, { stdio: 'ignore', windowsHide: true });
}

/**
 * @param {{ dataDir: string, platform?: NodeJS.Platform, disabled?: boolean }} options
 * @returns {{ supported: boolean, enabled: boolean, reason?: string }}
 */
export function status({ dataDir, platform = process.platform, disabled = false }) {
  if (!isWindows(platform)) {
    return { supported: false, enabled: false, reason: 'not_windows' };
  }
  if (disabled) {
    return { supported: true, enabled: false, reason: 'disabled' };
  }
  try {
    const output = execFileSync('reg.exe', ['query', RUN_KEY, '/v', VALUE_NAME], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return {
      supported: true,
      enabled: output.includes(VALUE_NAME),
      script: startupScriptPath(dataDir),
    };
  } catch {
    return { supported: true, enabled: false, script: startupScriptPath(dataDir) };
  }
}

/**
 * 写当前用户启动项，失败抛给 sync 统一降级。
 *
 * @param {{ dataDir: string, projectRoot: string, nodePath?: string, platform?: NodeJS.Platform }} options
 */
export function enable({
  dataDir,
  projectRoot,
  nodePath = process.execPath,
  platform = process.platform,
}) {
  if (!isWindows(platform)) {
    return { supported: false, enabled: false, reason: 'not_windows' };
  }
  mkdirSync(dataDir, { recursive: true });
  const script = startupScriptPath(dataDir);
  writeFileSync(script, buildStartupScript({ projectRoot, dataDir, nodePath }), 'utf8');
  runReg([
    'add',
    RUN_KEY,
    '/v',
    VALUE_NAME,
    '/t',
    'REG_SZ',
    '/d',
    `"${script}"`,
    '/f',
  ]);
  return { supported: true, enabled: true, script };
}

/**
 * @param {{ dataDir: string, platform?: NodeJS.Platform }} options
 */
export function disable({ dataDir, platform = process.platform }) {
  if (!isWindows(platform)) {
    return { supported: false, enabled: false, reason: 'not_windows' };
  }
  try {
    runReg(['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
  } catch {
    // 本来就不存在时 reg.exe 也返回非 0；移除是幂等的。
  }
  rmSync(startupScriptPath(dataDir), { force: true });
  return { supported: true, enabled: false };
}

/**
 * 启动时同步配置；任何失败只告警，不阻断主进程。
 *
 * @param {{
 *   dataDir: string,
 *   projectRoot: string,
 *   enabled: boolean,
 *   nodePath?: string,
 *   platform?: NodeJS.Platform,
 *   disabled?: boolean,
 *   log?: object,
 * }} options
 */
export function sync({
  dataDir,
  projectRoot,
  enabled,
  nodePath = process.execPath,
  platform = process.platform,
  disabled = false,
  log,
}) {
  if (!isWindows(platform) || disabled) {
    return { supported: isWindows(platform), enabled: false, reason: disabled ? 'disabled' : 'not_windows' };
  }
  try {
    return enabled
      ? enable({ dataDir, projectRoot, nodePath, platform })
      : disable({ dataDir, platform });
  } catch (err) {
    log?.warn('autostart_sync_failed', { message: err?.message ?? String(err) });
    return { supported: true, enabled: false, reason: 'failed' };
  }
}

/**
 * 测试与排障读取自启脚本，不触发系统调用。
 *
 * @param {string} dataDir
 */
export function readStartupScript(dataDir) {
  const file = startupScriptPath(dataDir);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
