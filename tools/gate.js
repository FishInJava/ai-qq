#!/usr/bin/env node
// 一条命令跑完"改完代码 → 过闸"的那半段：
//   preflight（分支/票）→ check（check + test + smoke）→ compliance（Rule 机检）
//   → format（只做安全收敛）→ commit（规范 message）→ pr（七段/五段 body）
//
// 设计约束，都来自本仓库：
// - 零依赖（ADR-0002）：只用 node: 内置模块，不装 prettier/eslint/husky。
// - 门禁只有一道（Workflow §6）：这里调用的是 npm scripts 背后同一个 node 进程，不另造检查。
// - 合并是人的动作（Rule §7-22）：本文件里没有 gh pr merge，也不会有。
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  ROOT, run, git, currentBranch, listFiles, mergeBase, commitsSince,
  readTextFile, fileSize, isTextTarget, listSince, listTracked, hasRemote, statusSince,
} from './gate/repo.js';
import {
  ERROR, WARN, parseConsent, checkPaths, checkContent, checkBranch, checkTicket,
  parseTicket, checkCommitSubjects, checkTestCoverage, checkScope, branchTicketNumber,
} from './gate/rules.js';
import { formatText, describeFixes } from './gate/format.js';
import { buildCommitMessage, buildPrBody } from './gate/ship.js';

const STAGES = ['preflight', 'check', 'compliance', 'format', 'commit', 'pr', 'install-hook', 'selftest'];
const ISSUE_ROOT = '.scratch';

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const options = {
    stage: 'all',
    base: null,
    consent: new Set(),
    paths: [],
    fix: false,
    fast: false,
    dryRun: true,
    push: false,
    create: false,
    hotfix: false,
    allowMain: false,
    stagedOnly: false,
    amend: false,
    subject: null,
    type: null,
    scope: null,
    body: null,
    bodyFile: null,
    title: null,
  };

  const valueFlags = {
    '--stage': 'stage', '--base': 'base', '--subject': 'subject', '--type': 'type',
    '--scope': 'scope', '--body': 'body', '--body-file': 'bodyFile', '--title': 'title',
  };
  const boolFlags = {
    '--fix': 'fix', '--fast': 'fast', '--push': 'push', '--create': 'create',
    '--hotfix': 'hotfix', '--allow-main': 'allowMain', '--no-dry-run': 'dryRun',
    '--staged': 'stagedOnly', '--amend': 'amend',
  };

  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [head, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];

    if (head === '--consent') {
      parseConsent(inline ?? argv[++i]).forEach((key) => options.consent.add(key));
      continue;
    }
    if (head === '--paths') {
      options.paths.push(...String(inline ?? argv[++i] ?? '').split(',').map((item) => item.trim()).filter(Boolean));
      continue;
    }
    if (valueFlags[head]) {
      options[valueFlags[head]] = inline ?? argv[++i] ?? null;
      continue;
    }
    if (boolFlags[head]) {
      options[boolFlags[head]] = head === '--no-dry-run' ? false : true;
      continue;
    }
    if (head === '--help' || head === '-h') {
      options.stage = 'help';
      continue;
    }
    if (!head.startsWith('-')) {
      rest.push(head);
      continue;
    }
    throw new Error(`未知参数 ${head}`);
  }

  if (rest.length > 0) options.stage = rest[0];
  if (options.stage === 'all' && options.fix) options.fix = true;
  return options;
}

const HELP = `用法：node tools/gate.js [stage] [flags]

stage（默认 all）
  all          preflight → check → compliance → format（不改盘）
  preflight    分支是否合规、票在不在
  check        门禁三段：npm run check / npm test / npm run smoke
  compliance   Rule.md 机检（G01…G28），秒级
  format       安全格式化；加 --fix 才写回并 git add
  commit       过闸后提交：规范 message + 显式 git add
  pr           生成 PR body；--push 推分支，--create 开 PR
  install-hook 装 .git/hooks/pre-commit（每台机器各自一次）
  selftest     跑 gate 自己的用例

flags
  --fix                 format 写回
  --fast                check 只跑静态自检，跳过 test 与 smoke
  --base=<ref>          对比基，默认 origin/main（没有远端时用 main）
  --consent=A7,A8       声明人已同意 Rule §8 某条（PR 里仍要贴答复原文）
  --paths=src,test      只看这些前缀下的文件
  --staged              只看已暂存的文件
  --hotfix              G26（改了 src 没改 test）降级
  --allow-main          明确知道自己在 main 上改文档
  --subject= --type= --scope=   commit 标题三件套，缺省从分支与票推导
  --body= --body-file=  bug 通道的四段正文
  --amend                commit 阶段改写上一个提交（推之前收尾用）
  --push --create       pr 阶段推分支 / 调 gh pr create

`;

// ---------------------------------------------------------------- 输出

const state = {
  branch: null,
  base: null,
  files: [],
  findings: [],
  gate: { check: null, test: null, smoke: null, testCounts: null },
  ticket: null,
  ticketPath: null,
  commits: [],
};

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function rel(file) {
  return file.replaceAll('\\', '/');
}

function formatFinding(finding) {
  const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''} ` : '';
  return `  ${finding.severity === ERROR ? 'ERROR' : ' WARN'} ${finding.id} ${where}${finding.message}`;
}

function printFindings(findings) {
  const errors = findings.filter((item) => item.severity === ERROR);
  const warnings = findings.filter((item) => item.severity === WARN);
  for (const finding of [...errors, ...warnings]) out(formatFinding(finding));
  return { errors, warnings };
}

// ---------------------------------------------------------------- 采集

function filterByPaths(files) {
  if (state.options.paths.length === 0) return files;
  return files.filter((file) => state.options.paths.some((prefix) => rel(file).startsWith(prefix)));
}

function collectFiles({ staged = false, all = false } = {}) {
  const files = filterByPaths(listFiles({ staged, all })).map((file) => ({ path: rel(file), size: fileSize(file) }));
  state.files = files.map((file) => file.path);
  return files;
}

function scanContent(files) {
  const findings = [];
  for (const file of files) {
    if (!isTextTarget(file.path)) continue;
    if (file.size > 512 * 1024) continue; // 已由 G04 报，读全文没必要
    let text;
    try {
      text = readTextFile(file.path);
    } catch (error) {
      findings.push({ id: 'G29', severity: WARN, file: file.path, message: `读不了（${error.message}），跳过内容扫描` });
      continue;
    }
    findings.push(...checkContent(file.path, text, { consent: state.options.consent }));
  }
  return findings;
}

function findIssueFile(number) {
  if (!number) return null;
  let features;
  try {
    features = readdirSync(path.join(ROOT, ISSUE_ROOT), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const feature of features) {
    if (!feature.isDirectory()) continue;
    const issuesDir = path.join(ROOT, ISSUE_ROOT, feature.name, 'issues');
    let entries;
    try {
      entries = readdirSync(issuesDir);
    } catch {
      continue;
    }
    const hit = entries.find((name) => new RegExp(`^0*${Number(number)}-`).test(name) && name.endsWith('.md'));
    if (hit) return path.posix.join(ISSUE_ROOT, feature.name, 'issues', hit);
  }
  return null;
}

function loadTicket() {
  const number = branchTicketNumber(state.branch ?? '');
  if (!number) return { ticket: null, ticketPath: null };
  const ticketPath = findIssueFile(number);
  if (!ticketPath) return { ticket: null, ticketPath: null };
  return { ticket: parseTicket(readTextFile(ticketPath)), ticketPath };
}

// ---------------------------------------------------------------- 各阶段

function stagePreflight(options) {
  out(`分支 ${state.branch} → base ${state.base}`);
  const findings = [...checkBranch({ branch: state.branch, allowMain: options.allowMain })];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 24) {
    findings.push({ id: 'G30', severity: ERROR, message: `Node ${process.versions.node} 低于 engines 要求的 24` });
  }

  const { ticket, ticketPath } = loadTicket();
  state.ticket = ticket;
  state.ticketPath = ticketPath;

  if (branchTicketNumber(state.branch ?? '') && !ticketPath) {
    findings.push({ id: 'G22', severity: ERROR, message: `ticket 分支找不到票文件：.scratch/*/issues/${branchTicketNumber(state.branch)}-*.md` });
  }

  if (ticket) {
    const blockers = ticket.blockedBy && !/^(?:none|无)/i.test(ticket.blockedBy) ? ticket.blockedBy : null;
    out(`票 ${rel(ticketPath)} · Status ${ticket.status}${blockers ? ` · Blocked by ${blockers}` : ''}`);
  }

  state.findings.push(...findings);
  const { errors } = printFindings(findings);
  out(errors.length === 0 ? '  OK' : `  ${errors.length} 处不建议继续`);
  return errors.length === 0;
}

function stageCheck(options) {
  const steps = [
    { key: 'check', label: 'npm run check', args: ['tools/check.js'] },
    ...(options.fast ? [] : [
      { key: 'test', label: 'npm test', args: ['--test', '--test-concurrency=4', 'test/**/*.test.js'], parse: parseTestCounts },
      { key: 'smoke', label: 'npm run smoke', args: ['tools/smoke.js'] },
    ]),
  ];

  let ok = true;
  for (const step of steps) {
    const started = process.hrtime.bigint();
    const result = run(process.execPath, step.args);
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const pass = result.code === 0;
    const counts = step.parse ? step.parse(result.stdout) : null;
    const detail = counts?.total ? ` ${counts.pass}/${counts.total}` : '';
    out(`  ${step.label.padEnd(22)} ${pass ? 'pass' : 'FAIL'}  ${seconds.toFixed(1)}s${detail}`);

    if (step.key === 'check') state.gate.check = pass ? 'pass' : 'fail';
    if (step.key === 'test') {
      state.gate.test = pass ? 'pass' : 'fail';
      state.gate.testCounts = pass ? parseTestCounts(result.stdout) : null;
    }
    if (step.key === 'smoke') state.gate.smoke = pass ? 'pass' : 'fail';

    if (!pass) {
      ok = false;
      out('  ── 失败输出（末尾 25 行）──');
      const text = `${result.stdout}\n${result.stderr}`.trimEnd().split('\n');
      for (const line of text.slice(-25)) out(`  ${line}`);
      break; // 前一步红就不跑后面（Workflow §6）
    }
  }

  return ok;
}

function parseTestCounts(stdout) {
  const pass = /^\s*(?:ℹ|#)\s*pass\s+(\d+)/m.exec(stdout)?.[1];
  const fail = /^\s*(?:ℹ|#)\s*fail\s+(\d+)/m.exec(stdout)?.[1];
  if (pass === undefined) return null;
  return { pass: Number(pass), total: Number(pass) + Number(fail ?? 0) };
}

function stageCompliance(options) {
  const files = collectFiles({ staged: options.stagedOnly });
  const findings = [
    ...checkPaths(files, { consent: options.consent }),
    ...scanContent(files),
    ...checkTestCoverage(state.files, { hotfix: options.hotfix }),
    ...checkScope(state.files),
  ];

  if (options.stage !== 'compliance') {
    // commit / pr 阶段要拦关票那三条
    const { ticket, ticketPath } = loadTicket();
    state.ticket = ticket ?? state.ticket;
    state.ticketPath = ticketPath ?? state.ticketPath;
    if (ticket) findings.push(...checkTicket({ ticket, path: ticketPath, stage: options.stage }));
  }

  out(`  扫了 ${files.length} 个文件`);
  state.findings.push(...findings);
  const { errors, warnings } = printFindings(findings);
  out(`  ${errors.length} error / ${warnings.length} warn`);
  return errors.length === 0;
}

function stageFormat(options) {
  const files = collectFiles({ staged: options.stagedOnly });
  const targets = files.filter((file) => isTextTarget(file.path) && file.size <= 512 * 1024);
  // 未跟踪的新文件先 git add 再格式化：替用户改他自己目录里的东西不算帮忙。
  const tracked = new Set(listTracked().map(rel));
  const changed = [];

  for (const file of targets) {
    let text;
    try {
      text = readTextFile(file.path);
    } catch {
      continue;
    }
    const formatted = formatText(file.path, text);
    if (formatted.text === text) continue;
    changed.push({ path: file.path, text: formatted.text, kinds: describeFixes(formatted.counts), tracked: tracked.has(file.path) });
  }

  if (changed.length === 0) {
    out(`  ${targets.length} 个文本文件，没有需要收敛的地方`);
    return true;
  }

  for (const item of changed) {
    const action = options.fix && item.tracked ? 'fix' : 'dry';
    out(`  ${action} ${item.path}  ${item.kinds.join('/')}`);
  }

  const writable = changed.filter((item) => item.tracked);
  const skipped = changed.length - writable.length;

  if (!options.fix) {
    out(`  ${changed.length} 个文件待收敛；加 --fix 写回`);
    return true;
  }

  for (const item of writable) writeFileSync(path.join(ROOT, item.path), item.text, 'utf8');
  if (writable.length > 0) git(['add', '--', ...writable.map((item) => item.path)]);
  out(`  已写回并 git add ${writable.length} 个文件${skipped > 0 ? `；${skipped} 个未跟踪文件不动（先 git add）` : ''}`);
  return true;
}

function stageCommit(options) {
  out('  ① 格式化（只动 git 认得的文件）');
  stageFormat({ ...options, fix: true });
  out('  ② 快检（全量测试留给 pr 和 CI，别为一行改动等 26 秒）');
  const checkOk = stageCheck({ ...options, fast: true });
  out('  ③ 合规');
  const complianceOk = stageCompliance(options);
  if (!checkOk || !complianceOk) {
    out('  门禁或合规未过，不提交');
    return false;
  }

  collectFiles({ staged: options.stagedOnly });
  if (state.files.length === 0) {
    out('  没有可提交的改动');
    return false;
  }

  let message;
  try {
    // amend 时默认沿用原 message：推之前的收尾不该顺手改掉标题。
    const reuseExisting = options.amend && !options.subject && !options.body && !options.bodyFile;
    message = reuseExisting
      ? git(['log', '-1', '--format=%B'])
      : buildCommitMessage({
        branch: state.branch,
        files: state.files,
        ticket: state.ticket,
        ticketPath: state.ticketPath,
        gate: state.gate,
        type: options.type,
        scope: options.scope,
        subject: options.subject,
        body: options.body,
        bodyFile: options.bodyFile,
      });
  } catch (error) {
    out(`  ${error.message}`);
    return false;
  }
  if (options.dryRun) {
    out(`  ── commit message${options.amend ? '（amend）' : ''}（dry-run，加 --no-dry-run 才真的提交）──`);
    for (const line of message.trimEnd().split('\n')) out(`  ${line}`);
    return true;
  }

  git(['add', '-A', '--', ...state.files]);
  const messageFile = path.join(ROOT, '.git', 'gate-commit-msg.txt');
  writeFileSync(messageFile, message, 'utf8');
  const result = run('git', ['commit', ...(options.amend ? ['--amend'] : []), '-F', messageFile]);
  if (result.code !== 0) {
    out(`  git commit 失败：${result.stderr.trim()}`);
    return false;
  }
  out(`  已${options.amend ? '修正' : '提交'}：${git(['log', '-1', '--format=%h %s']).trim()}`);
  out('  下一步：node tools/gate.js pr（推分支要 --push，开 PR 要 --create）');
  return true;
}

function stagePr(options) {

  // 只看已跟踪文件的改动：工作区里躺着别人的未跟踪目录，不该拦住开 PR。
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).trim();
  if (dirty) {
    out('  工作区不干净，先提交再提 PR：');
    for (const line of dirty.split('\n').slice(0, 10)) out(`  ${line}`);
    return false;
  }

  const base = state.base;
  const commits = commitsSince(base);
  state.commits = commits;
  const findings = checkCommitSubjects(commits);
  const { errors } = printFindings(findings);
  if (errors.length > 0) return false;

  // 提 PR 前再跑一次门禁：PR body 里的勾选必须是刚跑出来的，不是回忆出来的（Workflow §6）。
  out('  开门禁（PR 描述里的结果来自这一次）');
  if (!stageCheck(options)) {
    out('  门禁红，不生成 PR。按 Workflow §7 分类后再来。');
    return false;
  }

  const files = listSince(base).map(rel);
  const changes = statusSince(base);
  const number = branchTicketNumber(state.branch ?? '');

  if (number) {
    const { ticket, ticketPath } = loadTicket();
    state.ticket = ticket;
    state.ticketPath = ticketPath;
    const ticketFindings = checkTicket({ ticket, path: ticketPath, stage: 'pr' });
    const printed = printFindings(ticketFindings);
    if (printed.errors.length > 0) return false;
  }

  const commitBody = git(['log', '-1', '--format=%B'], { allowFail: true });
  const { body, title } = buildPrBody({
    branch: state.branch,
    files,
    changes,
    gate: state.gate,
    consent: options.consent,
    ticket: state.ticket,
    ticketPath: state.ticketPath,
    commits,
    commitBody,
    number,

  });

  const bodyFile = path.join(ROOT, '.git', 'gate-pr-body.md');
  writeFileSync(bodyFile, body, 'utf8');
  out(`  PR body 已写到 .git/gate-pr-body.md（${body.split('\n').length} 行）`);

  if (options.dryRun && !options.push && !options.create) {
    out('  ── 预览 ──');
    for (const line of body.split('\n')) out(`  ${line}`);
    out('');
    out(`  推分支：node tools/gate.js pr --push`);
    out(`  开 PR ：node tools/gate.js pr --push --create`);
    return true;
  }

  if (options.push) {
    const push = run('git', ['push', '-u', 'origin', state.branch]);
    if (push.code !== 0) {
      out(`  push 失败：${push.stderr.trim()}`);
      return false;
    }
    out(`  已推送 ${state.branch}`);
  }

  if (options.create) {
    // gh 要的是主分支名，不是 git 的引用名：origin/main → main。
    const baseBranch = state.base.replace(/^origin\//, '');
    const create = run('gh', ['pr', 'create', '--base', baseBranch, '--title', options.title ?? title, '--body-file', bodyFile]);
    if (create.code !== 0) {
      out(`  gh pr create 失败：${create.stderr.trim()}`);
      return false;
    }
    out(`  ${create.stdout.trim()}`);
    out('  合并是人的动作（Rule §7-22）：这条命令里没有 merge。');
  }

  return true;
}

function stageSelfTest() {
  const result = run(process.execPath, ['--test', 'tools/gate/selftest.js']);
  const last = `${result.stdout}${result.stderr}`.trimEnd().split('\n').slice(-12);
  for (const line of last) out(`  ${line}`);
  return result.code === 0;
}

/**
 * 装 pre-commit hook。不装 Husky：那是个依赖，而这里只要七行 sh。
 * .git/hooks 不进版本库，所以这是每台机器各自 opt-in 的事，不替人装。
 */
function stageInstallHook() {
  const hooksDir = path.join(ROOT, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'pre-commit');

  if (existsSync(hookPath)) {
    out(`  ${rel(hookPath)} 已存在，不覆盖。要重装先删掉它。`);
    return true;
  }

  const script = [
    '#!/bin/sh',
    '# 由 node tools/gate.js install-hook 生成。想跳过：git commit --no-verify',
    '# 只跑快的那两条：全量测试留给 gate commit 和 CI，别让每次提交都等二十秒。',
    'node tools/gate.js check --fast || exit 1',
    'node tools/gate.js compliance || exit 1',
    '',
  ].join('\n');

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, script, { mode: 0o755 });
  out(`  已写入 ${rel(hookPath)}`);
  out('  之后 git commit 会先过快检；绕不过去的只有 --no-verify。');
  return true;
}

// ---------------------------------------------------------------- 主流程

function runStages(options) {
  state.branch = currentBranch();
  // 本地 main 常常落后，用它当基准会把别人的合并提交算成本分支的改动。
  state.base = options.base ?? (hasRemote() ? 'origin/main' : 'main');
  options.base = state.base;
  state.options = options;
  const base = mergeBase(state.base);
  out(`gate · 仓库 ${path.basename(ROOT)} · ${state.branch} → ${state.base}${base ? ` (${base.slice(0, 7)})` : ''}`);
  out('');

  if (options.stage === 'selftest') return stageSelfTest(options);
  if (options.stage === 'preflight') return stagePreflight(options);
  if (options.stage === 'check') return stageCheck(options);
  if (options.stage === 'compliance') return stageCompliance(options);
  if (options.stage === 'format') return stageFormat(options);
  if (options.stage === 'commit') return stageCommit(options);
  if (options.stage === 'pr') return stagePr(options);
  if (options.stage === 'install-hook') return stageInstallHook();

  // all：不改盘、不提交，只体检
  const preflight = stagePreflight(options);
  out('[2] 门禁');
  const check = stageCheck(options);
  out('[3] 合规扫描');
  const compliance = stageCompliance(options);
  out('[4] 格式化（dry-run）');
  const format = stageFormat(options);
  out('');
  const ok = preflight && check && compliance && format;
  out(ok
    ? '全过。下一步：node tools/gate.js --fix → commit → pr'
    : '有红。按上面的 ERROR 逐条改，别用 skip/放宽阈值绕（Rule §7-19）。');
  return ok;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    out(error.message);
    out(HELP);
    process.exitCode = 2;
    return;
  }

  if (options.stage === 'help') {
    out(HELP);
    return;
  }
  if (options.stage !== 'all' && !STAGES.includes(options.stage)) {
    out(`未知 stage：${options.stage}`);
    out(HELP);
    process.exitCode = 2;
    return;
  }

  const ok = runStages(options);
  if (!ok) process.exitCode = 1;
}

main();
