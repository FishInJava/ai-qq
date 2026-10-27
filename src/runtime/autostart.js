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

export function disable({ dataDir, platform = process.platform }) {
  if (!isWindows(platform)) {
    return { supported: false, enabled: false, reason: 'not_windows' };
  }
  try {
    runReg(['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
  } catch (error) {
    void error;
  }
  rmSync(startupScriptPath(dataDir), { force: true });
  return { supported: true, enabled: false };
}

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

export function readStartupScript(dataDir) {
  const file = startupScriptPath(dataDir);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
