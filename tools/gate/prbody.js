const STATUS_LABEL = { A: '新增', M: '改动', D: '删除', R: '重命名', C: '复制' };

const AREAS = [
  { test: /^src\/store\//, label: '数据（SQL 与迁移）', hard: true },
  { test: /^src\/http\//, label: '对外 HTTP/SSE 契约', hard: true },
  { test: /^src\//, label: '后端行为' },
  { test: /^web\//, label: '页面' },
  { test: /^test\//, label: '自动化用例' },
  { test: /^tools\//, label: '开发工具（gate）' },
  { test: /^\.dsh\//, label: 'agent 流程与 skill' },
  { test: /^docs\/adr\//, label: 'ADR（只追加）', hard: true },
  { test: /^docs\//, label: '文档' },
  { test: /^\.github\/workflows\//, label: 'CI 门禁', hard: true },
  { test: /^package\.json$/, label: '依赖与脚本声明', hard: true },
];

const FILE_LIMIT = 6;

function rel(path) {
  return String(path ?? '').replaceAll('\\', '/');
}

function toChanges({ changes, files }) {
  const raw = Array.isArray(changes) && changes.length > 0 ? changes : (files ?? []);
  return raw
    .map((item) => (typeof item === 'string' ? { path: rel(item) } : { path: rel(item.path), status: item.status }))
    .filter((item) => item.path.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function shapeTree(changes) {
  if (changes.length === 0) return '（相对 base 没有文件改动）';

  const roots = new Map();
  for (const change of changes) {
    const parts = change.path.split('/');
    const rootName = parts.length === 1 ? '.' : `${parts[0]}/`;
    if (!roots.has(rootName)) roots.set(rootName, []);
    roots.get(rootName).push({
      name: parts.length === 1 ? parts[0] : parts.slice(1).join('/'),
      status: STATUS_LABEL[change.status] ?? '改动',
    });
  }

  const rootNames = [...roots.keys()].sort((a, b) => (a === '.' ? 1 : b === '.' ? -1 : a.localeCompare(b)));
  const lines = [];
  for (const rootName of rootNames) {
    if (rootName !== '.') lines.push(rootName);
    const items = roots.get(rootName).sort((a, b) => a.name.localeCompare(b.name));
    items.forEach((item, index) => {
      lines.push(`${index === items.length - 1 ? '└── ' : '├── '}${item.name}  ${item.status}`);
    });
  }
  return lines.join('\n');
}

function shapeBlock(changes) {
  if (changes.length === 0) return '';
  return ['```text', shapeTree(changes), '```', ''].join('\n');
}

function evidenceBlock({ gate, changes }) {
  const counts = gate.testCounts ? `${gate.testCounts.pass}/${gate.testCounts.total}` : null;
  const local = [
    `check ${gate.check === 'pass' ? '无输出' : '见日志'}`,
    `test ${counts ? `${counts} 全过` : gate.test === 'pass' ? '全过' : '见日志'}`,
    `smoke ${gate.smoke === 'pass' ? '0' : '见日志'}`,
  ].join(' · ');
  const tests = changes.filter((change) => change.path.startsWith('test/'));
  const rows = [`- 本地：${local}；CI 双平台还没跑`];
  if (tests.length > 0) {
    rows.push(`- 用例：${tests.map((change) => `\`${change.path}\`（${STATUS_LABEL[change.status] ?? '改动'}）`).join('、')}`);
  }
  return rows.join('\n');
}

function impactBlock({ changes }) {
  const hits = [];
  for (const change of changes) {
    const area = AREAS.find((item) => item.test.test(change.path));
    if (area && !hits.includes(area)) hits.push(area);
  }
  const labels = hits.map((hit) => hit.label).join('、') || '未识别（补一句谁在用）';
  const hard = hits.filter((hit) => hit.hard).map((hit) => hit.label);
  const rollback = hard.length > 0
    ? `合错要先处理 ${hard.join('、')}，不是一次 revert 就干净。`
    : '回滚就是一次 `git revert`。';
  const noTests = changes.some((change) => change.path.startsWith('test/')) ? '' : '没动用例。';
  return `${labels}。${rollback}${noTests}`;
}

function filesBlock(changes) {
  if (changes.length === 0) return '（无文件改动）';
  const rows = changes.map((change) => `| \`${change.path}\` | ${STATUS_LABEL[change.status] ?? '改动'} |`);
  const table = ['| 文件 | 状态 |', '|---|---|', ...rows].join('\n');
  if (changes.length <= FILE_LIMIT) return table;
  return ['<details>', `<summary>改动文件（${changes.length} 个）</summary>`, '', table, '', '</details>'].join('\n');
}

function head({ changes, gate, what, how }) {
  const shape = shapeBlock(changes);
  const howBlock = how ? `\n## 怎么改的\n\n${how}\n` : '';
  return `## 这改了什么

${what}
${shape ? `\n${shape}` : ''}${howBlock}
## 怎么验的

${evidenceBlock({ gate, changes })}

## 会影响谁

${impactBlock({ changes })}

${filesBlock(changes)}
`;
}

function pullNotesValue(notes, label) {
  const match = new RegExp(`\\*\\*${label}\\*\\*[:：]\\s*([^\\n]+)`, 'u').exec(notes ?? '');
  return match ? match[1].trim() : null;
}

export function ticketPrBody({ branch, ticket, ticketPath, changes, files, gate, consent }) {
  const number = /(\d+)/.exec(branch)?.[1] ?? 'NN';
  const list = toChanges({ changes, files });
  const notes = ticket?.notesText ?? '';
  const acceptance = (ticket?.acceptance ?? []).map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`).join('\n') || '- [ ] ';
  const consentLine = consent.size > 0
    ? `涉及 ${[...consent].join('、')}（已获同意，答复见：____）`
    : ticket?.declaresNoConsent ? '不涉及 §8 任何条目' : '待填：不涉及 §8 / 涉及 ____（答复见 ____）';

  return `${head({
    changes: list,
    gate,
    what: ticket?.whatToBuild ?? '（从票里复制一句：用户现在能做什么了）',
    how: null,
  })}
## 验收项

${acceptance}

---

**票**：\`${number}\` · \`${ticketPath ?? `.scratch/proactive-companion-runtime/issues/${number}-*.md`}\`
**同意项**：${consentLine}
**偏差**：${pullNotesValue(notes, '偏差') ?? '无'}
**遗留**：${pullNotesValue(notes, '遗留') ?? '无'}
`;
}

export function fixPrBody({ branch, changes, files, gate, commits, commitBody }) {
  const parsed = parseFixBody(commitBody ?? '');
  const list = toChanges({ changes, files });
  const subject = commits.at(-1)?.subject ?? branch;
  const how = [parsed['根因'] && `根因：${parsed['根因']}`, parsed['修法'] && `修法：${parsed['修法']}`]
    .filter(Boolean)
    .join('\n');

  return `${head({
    changes: list,
    gate,
    what: parsed['症状'] ?? '（commit body 缺"症状"）',
    how: how || null,
  })}
---

无票（/fix-bug 通道）· ${subject}${parsed['验证'] ? `\n验证：${parsed['验证']}` : ''}
`;
}

export function plainPrBody({ changes, files, gate, commits }) {
  const list = toChanges({ changes, files });
  const what = commits.length > 0
    ? commits.map((commit) => `- ${commit.subject.replace(/^[\w-]+\([^)]*\):\s*/, '')}`).join('\n')
    : '（无 commit）';
  return head({ changes: list, gate, what, how: null });
}

export function parseFixBody(body) {
  const result = {};
  const lines = body.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const match = /^\s*(症状|根因|修法|验证|风险与回归面)\s*[:：]\s*(.*)$/u.exec(line);
    if (match) {
      current = match[1];
      result[current] = match[2].trim();
    } else if (current && line.trim().length > 0) {
      result[current] = `${result[current]}\n${line.trim()}`.trim();
    }
  }
  return result;
}
