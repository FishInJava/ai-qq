// 仓库读写最小层：只负责"问 git 要事实"和"读文件"，不做任何判断。
// 判断在 rules.js，改写文件在 format.js，编排在 ../gate.js。
// 为什么单独一层：selftest 要能不起 git、只喂内存里的 { path, text } 跑规则。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// 只对文本文件做内容扫描与格式化。二进制一旦被当文本改写就毁了，所以用白名单而不是黑名单。
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.gitattributes', '.gitignore', '.html', '.js', '.json',
  '.md', '.mjs', '.ps1', '.psm1', '.sh', '.sql', '.txt', '.yaml', '.yml',
]);
const TEXT_BASENAMES = new Set(['.gitattributes', '.gitignore', '.editorconfig']);

export function isTextTarget(file) {
  const base = path.basename(file);
  if (TEXT_BASENAMES.has(base)) return true;
  return TEXT_EXTENSIONS.has(path.extname(base).toLowerCase());
}

/** 跑一条命令，返回 { code, stdout, stderr }。不用 shell：Windows 上 .cmd 与引号会咬人。 */
export function run(command, args = []) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    return { code: 127, stdout: '', stderr: `${command}: ${result.error.message}` };
  }
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** 跑 git。allowFail 用于"这条命令在这里本来就可能没结果"的场景（如无 origin）。 */
export function git(args, { allowFail = false } = {}) {
  const result = run('git', args);
  if (result.code !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} 失败（${result.code}）：${result.stderr.trim()}`);
  }
  return result.stdout;
}

function splitNul(text) {
  return text.split('\0').filter((entry) => entry.length > 0);
}

export function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

/** 合并基。PR 的审查面就是 base...HEAD，不是 base..HEAD。 */
export function mergeBase(base) {
  const result = run('git', ['merge-base', base, 'HEAD']);
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * 本次要检查的文件集合。
 * - staged：只有已暂存
 * - all：全部追踪文件
 * - 默认：相对 HEAD 的改动 + 未跟踪（漏了未跟踪文件，新写的 rules.js 就查不到）
 */
export function listFiles({ staged = false, all = false } = {}) {
  if (all) return splitNul(git(['ls-files', '-z']));
  if (staged) {
    return splitNul(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']));
  }
  const tracked = splitNul(git(['diff', 'HEAD', '--name-only', '--diff-filter=ACMR', '-z'], { allowFail: true }));
  const untracked = splitNul(git(['ls-files', '--others', '--exclude-standard', '-z']));
  return [...new Set([...tracked, ...untracked])].sort();
}

export function listStaged() {
  return splitNul(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']));
}

/** 已在 git 视野里的文件。format 只改这些——未跟踪文件是用户自己的东西，别替他改。 */
export function listTracked() {
  return splitNul(git(['ls-files', '-z']));
}

export function listUntracked() {
  return splitNul(git(['ls-files', '--others', '--exclude-standard', '-z']));
}

/** base 分叉以来改过的文件（含已提交部分），用于"有没有配套测试"这类跨提交判断。 */
export function listSince(base) {
  const from = mergeBase(base) ?? base;
  return splitNul(git(['diff', '--name-only', '--diff-filter=ACMR', '-z', from, 'HEAD'], { allowFail: true }));
}

export function commitsSince(base) {
  const from = mergeBase(base) ?? base;
  return git(['log', '--reverse', '--format=%H%x1f%s', `${from}..HEAD`], { allowFail: true })
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [hash, subject] = line.split('\x1f');
      return { hash, subject };
    });
}

export function readTextFile(relativePath) {
  const absolute = path.join(ROOT, relativePath);
  return readFileSync(absolute, 'utf8');
}

export function fileExists(relativePath) {
  return existsSync(path.join(ROOT, relativePath));
}

export function fileSize(relativePath) {
  try {
    return statSync(path.join(ROOT, relativePath)).size;
  } catch {
    return 0;
  }
}

export function hasRemote(remote = 'origin') {
  return git(['remote'], { allowFail: true }).split('\n').includes(remote);
}

export function branchExistsOnRemote(branch, remote = 'origin') {
  return git(['ls-remote', '--heads', remote, branch], { allowFail: true }).trim().length > 0;
}
