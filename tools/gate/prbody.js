// PR 描述生成：把"票 + 本次改动 + 门禁结果"拼成审阅面。
// 两套版式来自 Workflow.md §9：票走七段（.github/pull_request_template.md），
// bug 走五段短版（.dsh/skills/fix-bug/SKILL.md §5）。模板不在这里重定义，只负责填。

const LAYERS = [
  { key: 'store', label: 'store', test: (file) => file.startsWith('src/store/') },
  { key: 'http', label: 'http', test: (file) => file.startsWith('src/http/') },
  { key: 'web', label: 'web', test: (file) => file.startsWith('web/') },
  { key: 'test', label: 'test', test: (file) => file.startsWith('test/') },
  { key: 'tools', label: 'tools', test: (file) => file.startsWith('tools/') },
  { key: 'docs', label: 'docs', test: (file) => /^(?:docs|\.scratch)\//.test(file) || /\.md$/.test(file) },
  { key: 'module', label: '业务', test: (file) => file.startsWith('src/') },
];

export function groupFiles(files) {
  const groups = new Map();
  for (const file of files) {
    const normalized = file.replaceAll('\\', '/');
    const layer = LAYERS.find((item) => item.test(normalized)) ?? { label: '其他' };
    if (!groups.has(layer.label)) groups.set(layer.label, []);
    groups.get(layer.label).push(normalized);
  }
  return [...groups.entries()].sort((a, b) => LAYERS.findIndex((l) => l.label === a[0]) - LAYERS.findIndex((l) => l.label === b[0]));
}

function gateLines(gate) {
  const mark = (ok) => (ok ? 'x' : ' ');
  const check = gate.check === 'pass';
  const test = gate.test === 'pass';
  const smoke = gate.smoke === 'pass';
  const counts = gate.testCounts ? `${gate.testCounts.pass}/${gate.testCounts.total}` : '—';
  return [
    `- [${mark(check)}] \`npm run check\` 无输出`,
    `- [${mark(test)}] \`npm test\` 全绿（${counts}）`,
    `- [${mark(smoke)}] \`npm run smoke\` 退出码 0`,
    '- [ ] CI 两个平台都绿（ubuntu + windows）',
  ].join('\n');
}

function changeTable(files) {
  const groups = groupFiles(files);
  if (groups.length === 0) return '（无文件改动）';
  const rows = ['| 层 | 文件 | 改了什么 |', '|---|---|---|'];
  for (const [label, list] of groups) {
    for (const file of list) rows.push(`| ${label} | \`${file}\` | — |`);
  }
  return rows.join('\n');
}

function pullNotesValue(notes, label) {
  const match = new RegExp(`\\*\\*${label}\\*\\*[:：]\\s*([^\\n]+)`, 'u').exec(notes ?? '');
  return match ? match[1].trim() : null;
}

/** 票通道：七段。缺的部分宁可留占位符，也不编。 */
export function ticketPrBody({ branch, ticket, ticketPath, files, gate, consent, commits }) {
  const number = /(\d+)/.exec(branch)?.[1] ?? 'NN';
  const notes = ticket?.notesText ?? '';
  const goal = ticket?.whatToBuild ?? '（从票里复制一句话）';
  const acceptance = (ticket?.acceptance ?? [])
    .map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`)
    .join('\n') || '- [ ] ';

  const consentLine = consent.size > 0
    ? `- [x] 涉及：${[...consent].join('、')}（已获同意，答复见：____）`
    : ticket?.declaresNoConsent
      ? '- [x] 本票不涉及 §8 任何条目'
      : '- [ ] 本票不涉及 §8 任何条目\n- [ ] 涉及：____（已获同意，答复见：____）';

  const deviation = pullNotesValue(notes, '偏差') ?? '无';
  const leftover = pullNotesValue(notes, '遗留') ?? '无';

  return `## 这张票

**票号**：\`${number}\`
**票文件**：\`${ticketPath ?? `.scratch/proactive-companion-runtime/issues/${number}-*.md`}\`

**目标（用户能做什么了）**：

${goal}

<!-- 由 tools/gate.js pr 生成。改动面第三列与"偏差与风险"需人补一句。 -->

## 改动面

${changeTable(files)}

## 验收项

${acceptance}

## 门禁

${gateLines(gate)}

## 偏差与风险

- 偏差：${deviation}
- 风险：无

## 同意项

${consentLine}

## 遗留

${leftover}
`;
}

/** bug 通道：五段短版，内容来自 commit message 的 body。 */
export function fixPrBody({ branch, files, gate, commits, commitBody }) {
  const parsed = parseFixBody(commitBody ?? '');
  const subject = commits.at(-1)?.subject ?? branch;

  return `## 症状

${parsed['症状'] ?? '（commit body 缺"症状"）'}

## 根因

${parsed['根因'] ?? '（commit body 缺"根因"）'}

## 改动

${files.length > 0 ? files.map((file) => `- \`${file.replaceAll('\\', '/')}\``).join('\n') : '- （无文件改动）'}

## 验证

${parsed['验证'] ?? '（commit body 缺"验证"）'}

- \`npm run check\` ${gate.check === 'pass' ? '无输出' : '见日志'} / \`npm test\` ${gate.testCounts ? `${gate.testCounts.pass}/${gate.testCounts.total}` : '—'} / \`npm run smoke\` ${gate.smoke === 'pass' ? '退出码 0' : '见日志'}

## 风险与回归面

${parsed['风险与回归面'] ?? parsed['修法'] ?? '无，改动局限于上面列出的文件'}

关联：无票（/fix-bug 通道）— ${subject}
`;
}

/** 既没票也不是 bug（chore/ docs/）：照实说改了哪些文件，不硬套两套模板。 */
export function plainPrBody({ files, gate, commits }) {
  const list = files.length > 0
    ? files.map((file) => `- \`${file.replaceAll('\\', '/')}\``).join('\n')
    : '- （无文件改动）';
  return `## 改了什么

${commits.length > 0 ? commits.map((commit) => `- ${commit.subject}`).join('\n') : '- —'}

改动文件：

${list}

## 门禁

${gateLines(gate)}

## 风险与回归面

无，改动局限于上面列出的文件。
`;
}

/** 从 commit body 里按"段落标题：内容"切。缺哪段就返回空对象，交给调用方提示。 */
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
