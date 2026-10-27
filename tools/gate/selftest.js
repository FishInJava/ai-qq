// gate 自身的用例：规则是不是真能命中、是不是会误伤。
// 为什么放在 tools 里而不是 test/：test/ 是产品三个缝（S1/S2/S3，ADR-0004），
// 把工具的自检塞进去会把"缝"的含义搞糊。这里用 node --test 跑同一个文件即可。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ERROR, WARN, parseConsent, parseTicket, checkPaths, checkContent,
  checkBranch, checkTicket, checkCommitSubjects, checkTestCoverage, checkScope,
} from './rules.js';
import { formatText, describeFixes } from './format.js';
import { parseFixBody } from './prbody.js';

const ids = (findings) => findings.map((finding) => finding.id);

// 样本里不能出现真的密钥形态与空 catch 字面量，否则 gate 扫自己会误报。
// 拼接出来的字符串在运行时和字面量一样，源码文本却躲开了正则。
const FAKE_SECRET = `sk-${'a'.repeat(24)}`;
const FAKE_PLACEHOLDER = `sk-${'x'.repeat(24)}`;
const EMPTY_CATCH_SAMPLE = `try { a(); } catch (error) {${'}'}`;
const FILLED_CATCH_SAMPLE = 'try { a(); } catch (error) { log.warn(error); }';

test('G01 运行时数据、密钥、排障产物一律拦', () => {
  for (const file of ['data/companion.db', 'data/config.json', '.tmp-real/config.json', '.repro.out', 'NUL', 'logs/app-20260101.log', '.env']) {
    const findings = checkPaths([{ path: file }]);
    assert.ok(ids(findings).includes('G01'), `${file} 没被拦`);
    assert.equal(findings[0].severity, ERROR);
  }
  assert.equal(ids(checkPaths([{ path: 'src/index.js' }])).length, 0);
});

test('G02 上游只读产物：默认拦，声明 A7 后降级', () => {
  const blocked = checkPaths([{ path: 'prototype/index.html' }]);
  assert.equal(blocked[0].id, 'G02');
  assert.equal(blocked[0].severity, ERROR);

  const waived = checkPaths([{ path: 'prototype/index.html' }], { consent: parseConsent('A7') });
  assert.equal(waived[0].severity, WARN);
});

test('G03 CI 门禁：默认拦，声明 A8 后降级', () => {
  assert.equal(checkPaths([{ path: '.github/workflows/ci.yml' }])[0].id, 'G03');
  assert.equal(checkPaths([{ path: '.github/workflows/ci.yml' }], { consent: parseConsent('A8') })[0].severity, WARN);
});

test('G04/G05 大文件与 lockfile', () => {
  assert.equal(checkPaths([{ path: 'web/app.js', size: 900 * 1024 }])[0].id, 'G04');
  assert.equal(checkPaths([{ path: 'package-lock.json' }])[0].id, 'G05');
});

test('G10 硬编码密钥命中，占位符不误伤', () => {
  const secret = checkContent('src/llm/client.js', `const k = "${FAKE_SECRET}";`);
  assert.equal(secret[0].id, 'G10');

  const placeholder = checkContent('src/llm/client.js', `const k = "${FAKE_PLACEHOLDER}";`);
  assert.equal(placeholder.length, 0, '占位符被当成真密钥了');

  const docExample = checkContent('docs/ARCHITECTURE.md', `"api_key": "${FAKE_SECRET}"`);
  assert.equal(docExample.length, 1, '文档里的密钥形态要报出来，让人自己判断是不是示例');
  assert.equal(docExample[0].severity, WARN, '文档里的示例不该拦提交');
});

test('G11 测试被 skip/only 拦下', () => {
  assert.equal(checkContent('test/s1/t01.test.js', 'test.skip("x", () => {});')[0].id, 'G11');
  assert.equal(checkContent('src/index.js', 'const skipped = 1;').length, 0);
});

test('G12 空 catch 拦下，有内容的不拦', () => {
  assert.equal(checkContent('src/store/index.js', EMPTY_CATCH_SAMPLE)[0].id, 'G12');
  assert.equal(checkContent('src/store/index.js', FILLED_CATCH_SAMPLE).length, 0);
});

test('G13 角色文案里的系统腔拦下，界面文案不拦', () => {
  assert.equal(checkContent('src/chat/prompt.js', 'const t = "作为一个AI，我不能";')[0].id, 'G13');
  assert.equal(checkContent('src/http/errors.js', '{ 429: "配额不足" }').length, 0, '界面角标文案被误伤');
});

test('G21/G20 分支名与 main', () => {
  assert.equal(checkBranch({ branch: 'main' })[0].severity, ERROR);
  assert.equal(checkBranch({ branch: 'main', allowMain: true })[0].severity, WARN);
  assert.equal(checkBranch({ branch: 'ticket-19-agent-gate' }).length, 0);
  assert.equal(checkBranch({ branch: 'fix-startup-url' }).length, 0);
  assert.equal(checkBranch({ branch: 'tmp-work' })[0].id, 'G21');
});

test('票解析：Status、验收项、Notes', () => {
  const text = [
    '# 18: 冷启动沉默',
    '',
    '**What to build:** 重启后已聊过的角色不再被沉默。',
    '',
    '**Status:** done',
    '',
    '## 验收项',
    '',
    '- [x] 老会话重启后不沉默',
    '- [ ] 新会话仍沉默',
    '',
    '## Notes',
    '',
    '**偏差**：无',
  ].join('\n');

  const ticket = parseTicket(text);
  assert.equal(ticket.status, 'done');
  assert.equal(ticket.whatToBuild, '重启后已聊过的角色不再被沉默。');
  assert.equal(ticket.acceptance.length, 2);
  assert.equal(ticket.unchecked.length, 1);
  assert.equal(ticket.hasNotes, true);
  assert.match(ticket.notesText, /偏差/);

  const findings = checkTicket({ ticket, path: '.scratch/x/issues/18.md', stage: 'pr' });
  assert.deepEqual(ids(findings), ['G24']);
  assert.equal(findings[0].severity, ERROR);
});

test('G27 commit 标题规范', () => {
  assert.equal(checkCommitSubjects([{ hash: 'a'.repeat(40), subject: 'feat(schedule): 冷启动只作用于新会话' }]).length, 0);
  assert.equal(checkCommitSubjects([{ hash: 'b'.repeat(40), subject: '改了点东西' }])[0].id, 'G27');
});

test('G26/G28 测试缺失与改动面过宽', () => {
  assert.equal(checkTestCoverage(['src/schedule/index.js'])[0].id, 'G26');
  assert.equal(checkTestCoverage(['src/schedule/index.js'], { hotfix: true }).length, 0);
  assert.equal(checkTestCoverage(['src/schedule/index.js', 'test/s2/t10.test.js']).length, 0);
  assert.equal(checkScope(['src/a/x.js', 'src/b/x.js', 'src/c/x.js', 'src/d/x.js', 'src/e/x.js', 'src/f/x.js'])[0].id, 'G28');
});

test('格式化：只做安全收敛，Markdown 行尾空格不动', () => {
  const messy = '\uFEFFa  \r\n\r\n\r\n\r\nb';
  const formatted = formatText('src/x.js', messy);
  assert.equal(formatted.text, 'a\n\nb\n');
  assert.deepEqual(describeFixes(formatted.counts).sort(), ['BOM', '多余空行', '文件末尾换行', '换行不一致', '行尾空白'].sort());

  const markdown = formatText('docs/x.md', 'hard break  \nline\n');
  assert.equal(markdown.text, 'hard break  \nline\n', 'Markdown 的两个空格是硬换行，不能被吃掉');

  const ps1 = formatText('tools/run.ps1', 'a\nb\n');
  assert.equal(ps1.text, 'a\r\nb\r\n', 'ps1 按 .gitattributes 保持 CRLF');

  const clean = formatText('src/y.js', 'const a = 1;\n');
  assert.equal(describeFixes(clean.counts).length, 0);
});

test('bug 通道的 commit body 能拆成五段', () => {
  const body = ['症状：端口被占时仍打印 3000', '根因：读的是配置值', '修法：用返回值', '验证：test/s1/t17.test.js'].join('\n');
  const parsed = parseFixBody(body);
  assert.equal(parsed['症状'], '端口被占时仍打印 3000');
  assert.equal(parsed['修法'], '用返回值');
});

test('PR body 按通道选版式：票七段 / bug 五段 / 其余照实列', async () => {
  const { buildPrBody } = await import('./ship.js');
  const gate = { check: 'pass', test: 'pass', smoke: 'pass', testCounts: { pass: 108, total: 108 } };

  const ticket = buildPrBody({
    branch: 'ticket-19-gate',
    files: ['tools/gate.js'],
    gate,
    consent: new Set(),
    ticket: { title: '门禁流水线', whatToBuild: '一条命令过闸', acceptance: [{ checked: true, text: '能跑' }], declaresNoConsent: true },
    ticketPath: '.scratch/x/issues/19-gate.md',
    commits: [{ subject: 'feat(tools): 门禁流水线' }],
    number: '19',
  });
  assert.match(ticket.title, /^ticket-19: /);
  assert.match(ticket.body, /## 验收项/);
  assert.match(ticket.body, /- \[x\] 能跑/);

  const fix = buildPrBody({
    branch: 'fix-port',
    files: ['src/http/server.js'],
    gate,
    consent: new Set(),
    commits: [{ subject: 'fix(http): 端口占用后仍打印旧端口' }],
    commitBody: '症状：打印 3000\n根因：读配置\n修法：用返回值\n验证：t17',
  });
  assert.match(fix.body, /## 症状\n\n打印 3000/);

  const chore = buildPrBody({
    branch: 'chore/agent-gate',
    files: ['tools/gate.js'],
    gate,
    consent: new Set(),
    commits: [{ subject: 'chore(tools): 新增 gate' }],
  });
  assert.match(chore.body, /## 改了什么/);
  assert.doesNotMatch(chore.body, /缺症状/, 'chore 分支不该被套进 bug 版式');
});
