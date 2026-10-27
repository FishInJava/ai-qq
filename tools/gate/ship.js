// 出货那半段：commit message 怎么拼、PR 标题怎么起。
// 单独一层，是为了 gate.js 里只剩"流程 + 打印"，别让模板字符串埋掉阶段顺序。
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readTextFile } from './repo.js';
import { ticketPrBody, fixPrBody, plainPrBody } from './prbody.js';

export function inferType(branch) {
  if (branch.startsWith('fix-')) return 'fix';
  if (branch.startsWith('ticket-')) return 'feat';
  if (branch.startsWith('docs')) return 'docs';
  return 'chore';
}

/** scope 取改动最集中的那一层：`src/<模块>` 优先，其次 web/test/tools/docs。 */
export function inferScope(files) {
  const counts = new Map();
  for (const file of files) {
    const match = /^src\/([\w-]+)\//.exec(file) ?? /^(web|test|tools|docs|\.scratch)\//.exec(file);
    const scope = match?.[1] ?? 'repo';
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'repo';
}

function loadBody(body, bodyFile) {
  if (body) return body;
  if (!bodyFile) return null;
  if (path.isAbsolute(bodyFile)) return readFileSync(bodyFile, 'utf8');
  return readTextFile(bodyFile);
}

/**
 * 票通道：标题取票标题，正文带票路径 + 改动面 + 门禁结果。
 * bug 通道：四段正文是硬要求（Workflow §9.1），缺了直接抛，不替人编。
 */
export function buildCommitMessage({ branch, files, ticket, ticketPath, gate, type, scope, subject, body, bodyFile }) {
  const commitType = type ?? inferType(branch);
  const commitScope = scope ?? inferScope(files);
  const commitSubject = subject ?? ticket?.title ?? branch.replace(/^[^/]*\//, '');
  const text = loadBody(body, bodyFile);

  const lines = [`${commitType}(${commitScope}): ${commitSubject}`, ''];

  if (commitType === 'fix') {
    if (!text) {
      const error = new Error([
        'bug 通道必须带四段正文（Workflow §9.1）。',
        '用 --body="症状：… 根因：… 修法：… 验证：…"',
        '或先写 .git/gate-commit-body.md 再 --body-file=.git/gate-commit-body.md',
      ].join('\n'));
      error.code = 'GATE_MISSING_BODY';
      throw error;
    }
    lines.push(text.trim());
    return `${lines.join('\n')}\n`;
  }

  if (ticketPath) lines.push(`票：${ticketPath}`);
  lines.push('改动面：');
  for (const file of files.slice(0, 20)) lines.push(`- ${file}`);
  if (files.length > 20) lines.push(`- …另有 ${files.length - 20} 个文件`);
  if (text) lines.push('', text.trim());
  lines.push('', `验证：node tools/gate.js（check ${gate.check ?? '未跑'} / test ${gate.test ?? '未跑'} / smoke ${gate.smoke ?? '未跑'}）`);

  return `${lines.join('\n')}\n`;
}

/** 返回 { title, body }。票走七段，fix- 走五段，其余照实列改动。 */
export function buildPrBody({ branch, files, gate, consent, ticket, ticketPath, commits, commitBody, number }) {
  if (number) {
    return {
      title: `ticket-${number}: ${ticket?.title ?? branch}`,
      body: ticketPrBody({ branch, ticket, ticketPath, files, gate, consent, commits }),
    };
  }
  if (branch.startsWith('fix-')) {
    return {
      title: commits.at(-1)?.subject ?? branch,
      body: fixPrBody({ branch, files, gate, commits, commitBody }),
    };
  }
  return {
    title: commits.at(-1)?.subject ?? branch,
    body: plainPrBody({ files, gate, commits }),
  };
}
