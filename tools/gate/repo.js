import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

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

export function mergeBase(base) {
  const result = run('git', ['merge-base', base, 'HEAD']);
  return result.code === 0 ? result.stdout.trim() : null;
}

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

export function listTracked() {
  return splitNul(git(['ls-files', '-z']));
}

export function listUntracked() {
  return splitNul(git(['ls-files', '--others', '--exclude-standard', '-z']));
}

export function listSince(base) {
  const from = mergeBase(base) ?? base;
  return splitNul(git(['diff', '--name-only', '--diff-filter=ACMR', '-z', from, 'HEAD'], { allowFail: true }));
}

export function statusSince(base) {
  const from = mergeBase(base) ?? base;
  const parts = git(['diff', '--name-status', '--diff-filter=ACMRD', '-z', from, 'HEAD'], { allowFail: true }).split('\0');
  const changes = [];
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i];
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      i += 2;
      if (parts[i]) changes.push({ path: parts[i], status: code[0] });
      continue;
    }
    i += 1;
    if (parts[i]) changes.push({ path: parts[i], status: code[0] });
  }
  return changes;
}

export function commitsSince(base) {
  return git(['log', '--reverse', '--format=%H%x1f%s', `${base}..HEAD`], { allowFail: true })
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
