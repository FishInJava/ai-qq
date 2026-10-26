import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TIME_API = /\b(?:Date\.now|new\s+Date|setTimeout|setInterval|Date\.parse)\b/;
const SQL = /\b(?:SELECT\b|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+TABLE\b|PRAGMA\s+\w+)/i;
const THIRD_PARTY_IMPORT = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
const STORE_HANDLE = /(?:from\s+|import\s*\()\s*['"][^'"]*store\/handle[^'"]*['"]/;
const TEST_FOCUS = /\b(?:test|it|describe)\.(?:skip|only)\b/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function collectImportSpecifiers(text) {
  const specs = [];
  for (const regex of [THIRD_PARTY_IMPORT, SIDE_EFFECT_IMPORT]) {
    regex.lastIndex = 0;
    let match = regex.exec(text);
    while (match) {
      specs.push({ spec: match[1], index: match.index });
      match = regex.exec(text);
    }
  }
  return specs;
}

const problems = [];

function report(file, text, index, message) {
  problems.push(`${rel(file)}:${lineOf(text, index)} ${message}`);
}

const srcFiles = walk(path.join(ROOT, 'src')).filter((file) => file.endsWith('.js'));
for (const file of srcFiles) {
  const text = readFileSync(file, 'utf8');
  const relative = rel(file);
  const isClock = relative.startsWith('src/clock/');
  const isSchedule = relative.startsWith('src/schedule/');
  const isRuntime = relative.startsWith('src/runtime/');
  const isStore = relative.startsWith('src/store/');

  if (!isClock && !isSchedule) {
    const match = TIME_API.exec(text);
    if (match) {
      report(file, text, match.index, `裸时间 API：${match[0]}`);
    }
  }

  const consoleMatch = /\bconsole\./.exec(text);
  if (consoleMatch) {
    report(file, text, consoleMatch.index, '业务代码禁止 console.*');
  }

  if (!isRuntime && !relative.endsWith('src/index.js')) {
    const envMatch = /process\.env\b/.exec(text);
    if (envMatch) {
      report(file, text, envMatch.index, '只有 runtime 可以读 process.env');
    }
  }

  if (!isStore) {
    const sqlMatch = SQL.exec(text);
    if (sqlMatch) {
      report(file, text, sqlMatch.index, `SQL 只能出现在 src/store：${sqlMatch[0]}`);
    }
    const handleMatch = STORE_HANDLE.exec(text);
    if (handleMatch) {
      report(file, text, handleMatch.index, '业务模块不能拿 store 的数据库句柄');
    }
  }

  const requireMatch = /\brequire\s*\(/.exec(text);
  if (requireMatch) {
    report(file, text, requireMatch.index, 'ESM 项目禁止 require()');
  }

  for (const { spec, index } of collectImportSpecifiers(text)) {
    if (!spec.startsWith('.') && !spec.startsWith('node:')) {
      report(file, text, index, `禁止第三方依赖：${spec}`);
    }
  }
}

const webFiles = walk(path.join(ROOT, 'web')).filter((file) => /\.(?:js|html)$/.test(file));
for (const file of webFiles) {
  const text = readFileSync(file, 'utf8');
  const timeMatch = TIME_API.exec(text);
  if (timeMatch) {
    report(file, text, timeMatch.index, `页面不能承担定时：${timeMatch[0]}`);
  }
  const sqlMatch = SQL.exec(text);
  if (sqlMatch) {
    report(file, text, sqlMatch.index, `页面不能出现 SQL：${sqlMatch[0]}`);
  }
  const storageMatch = /\b(?:localStorage|sessionStorage|indexedDB)\b/.exec(text);
  if (storageMatch) {
    report(file, text, storageMatch.index, '页面不能把业务状态当权威');
  }
}

const testFiles = walk(path.join(ROOT, 'test')).filter((file) => file.endsWith('.js'));
for (const file of testFiles) {
  const text = readFileSync(file, 'utf8');
  const focusMatch = TEST_FOCUS.exec(text);
  if (focusMatch) {
    report(file, text, focusMatch.index, '禁止 skip/only');
  }
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  problems.push('package.json 不允许 dependencies（ADR-0002）');
}
if (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) {
  problems.push('package.json 不允许 devDependencies（ADR-0002）');
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
}
