// 合规规则：把 Rule.md 里"人肉才看得出"的条款变成机检。
// 每条规则给一个稳定 ID（G01…），报告里能直接 grep，PR 里也能引用。
// 这里全是纯函数：输入文件/文本，输出 findings。不读 git、不写盘——selftest 靠这一点。
import path from 'node:path';

export const ERROR = 'error';
export const WARN = 'warn';

const MB = 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;

/** Rule §8 的同意项：声明了才降级，且 PR 里必须贴人的答复原文。 */
const CONSENT_KEYS = new Set(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13']);

export function parseConsent(raw) {
  const consent = new Set();
  for (const part of String(raw ?? '').split(/[,\s]+/)) {
    const key = part.trim().toUpperCase();
    if (CONSENT_KEYS.has(key)) consent.add(key);
  }
  return consent;
}

function finding(id, severity, message, extra = {}) {
  return { id, severity, message, ...extra };
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

// ---------------------------------------------------------------- 路径规则

const RUNTIME_DATA = /^(?:data|logs|coverage)\/|(?:^|\/)\.env(?:\.|$)|\.db(?:-wal|-shm|-journal)?$|^(?:\.tmp-|\.?repro[./-])|(?:^|\/)NUL$|\.corrupt-[\w-]*\.db$/;
const UPSTREAM_READONLY = /^prototype\/|^主动陪伴AI聊天助手_PRD|^docs\/ai-companion-spec\.md$|^docs\/agents\//;
const CI_GATE = /^\.github\/(?:workflows|actions)\//;
const FLOW_DOCS = /^(?:AGENTS|Rule|Workflow|GLOSSARY)\.md$/;

const KEEP_OUT_OF_GIT = [
  // 命中即拦：这些进了仓库，等于把用户的对话、密钥或调试现场公开。
  { id: 'G01', pattern: RUNTIME_DATA, message: '运行时数据 / 密钥 / 排障产物不入库（Rule §7-18、.gitignore）' },
  { id: 'G02', pattern: UPSTREAM_READONLY, text: '上游只读产物被改（Rule §8-A7）；确属人已同意就 --consent=A7', consent: 'A7' },
  { id: 'G03', pattern: CI_GATE, message: '改 CI 门禁属 Rule §8-A8，须先取得人同意；已同意就 --consent=A8', consent: 'A8' },
];

/**
 * 路径级检查。
 * @param {{ path: string, size?: number }[]} files
 * @param {{ consent?: Set<string> }} options
 */
export function checkPaths(files, { consent = new Set() } = {}) {
  const findings = [];

  for (const file of files) {
    const normalized = file.path.replaceAll('\\', '/');

    for (const rule of KEEP_OUT_OF_GIT) {
      if (!rule.pattern.test(normalized)) continue;
      const waived = rule.consent && consent.has(rule.consent);
      findings.push(finding(
        rule.id,
        waived ? WARN : ERROR,
        waived ? `${rule.text}（已声明 ${rule.consent}，PR 里要贴答复原文）` : (rule.text ?? rule.message),
        { file: normalized },
      ));
    }

    if ((file.size ?? 0) > MAX_FILE_BYTES) {
      findings.push(finding('G04', ERROR, `单文件 ${(file.size / MB).toFixed(2)}MB 超过 512KB，确认不是误加的产物`, { file: normalized }));
    }

    if (normalized === 'package-lock.json' || normalized === 'node_modules/.package-lock.json') {
      findings.push(finding('G05', ERROR, '本项目零依赖（ADR-0002），出现 lockfile 说明有人装了包', { file: normalized }));
    }

    if (FLOW_DOCS.test(normalized)) {
      findings.push(finding('G06', WARN, '改了流程文档：PR 里必须说明改的是哪条、为什么', { file: normalized }));
    }
  }

  return findings;
}

// ---------------------------------------------------------------- 内容规则

const SECRET_PATTERNS = [
  { id: 'G10', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, label: '疑似 OpenAI 风格密钥' },
  { id: 'G10', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, label: '疑似 GitHub token' },
  { id: 'G10', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, label: '疑似 Slack token' },
  { id: 'G10', pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: '疑似 AWS access key' },
  { id: 'G10', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g, label: '私钥块' },
];

const API_KEY_ASSIGN = /\bapi[_-]?key\b\s*[:=]\s*["']([^"']{16,})["']/gi;
const PLACEHOLDER = /^[x*<.{]+$|xxxx|YOUR_|REPLACE|CHANGE_ME|EXAMPLE|test[-_]?key|REDACTED/i;

/** `sk-xxxx`、`sk-<your key>`、`sk-***` 是文档占位符，不是泄露。 */
function looksPlaceholder(value) {
  return PLACEHOLDER.test(value) || value.includes('<') || value.includes('…');
}

const FOCUS_MARKERS = /\b(?:test|it|describe)\.(?:skip|only)\b|\b(?:test|it|describe)\([^)]*\{\s*skip:/g;
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
const SYSTEM_TONE = /(?:作为|身为)\s*(?:一个)?\s*AI\b|(?:token|Token)\s*(?:余额|不足|上限|耗尽)|配额\s*(?:不足|已满|耗尽)|(?:超出|超过)\s*(?:额度|配额)/g;

const SYSTEM_TONE_SCOPE = /^src\/(?:chat|proactive|style)\//;
const CODE_SCOPE = /^(?:src|tools|web|test)\//;

/**
 * 内容级检查。文本文件才进这里（二进制调用方负责跳过）。
 * @param {string} file 仓库相对路径
 * @param {string} text 文件全文
 * @param {{ consent?: Set<string> }} options
 */
export function checkContent(file, text, { consent = new Set() } = {}) {
  const findings = [];
  const normalized = file.replaceAll('\\', '/');
  const isMarkdown = /\.md$/i.test(normalized);

  for (const secret of SECRET_PATTERNS) {
    secret.pattern.lastIndex = 0;
    const match = secret.pattern.exec(text);
    if (!match || looksPlaceholder(match[0])) continue;
    // 文档里写 `sk-...` 八成是例子（本仓库 Rule.md 自己就在讲密钥怎么存），降级不放过。
    findings.push(finding(
      'G10',
      isMarkdown ? WARN : ERROR,
      `${secret.label}${isMarkdown ? '（文档里，确认是示例就忽略）' : ''}：${match[0].slice(0, 8)}…`,
      { file: normalized, line: lineOf(text, match.index) },
    ));
  }

  // 文档里的 api_key 例子是正常的（Rule.md 就在讲这件事），只查代码文件。
  if (!isMarkdown && CODE_SCOPE.test(normalized)) {
    API_KEY_ASSIGN.lastIndex = 0;
    let match = API_KEY_ASSIGN.exec(text);
    while (match) {
      if (!PLACEHOLDER.test(match[1])) {
        findings.push(finding('G10', ERROR, '硬编码 api_key 字面量', {
          file: normalized,
          line: lineOf(text, match.index),
        }));
      }
      match = API_KEY_ASSIGN.exec(text);
    }
  }

  FOCUS_MARKERS.lastIndex = 0;
  const focus = FOCUS_MARKERS.exec(text);
  if (focus && /(?:^|\/)test\//.test(normalized)) {
    findings.push(finding('G11', ERROR, '测试被 skip/only 了（Rule §7-19）', {
      file: normalized,
      line: lineOf(text, focus.index),
    }));
  }

  if (CODE_SCOPE.test(normalized) && !isMarkdown) {
    EMPTY_CATCH.lastIndex = 0;
    const emptyCatch = EMPTY_CATCH.exec(text);
    if (emptyCatch) {
      findings.push(finding('G12', ERROR, '空 catch（Rule §3.2：要么处理要么带上下文重抛）', {
        file: normalized,
        line: lineOf(text, emptyCatch.index),
      }));
    }
  }

  if (SYSTEM_TONE_SCOPE.test(normalized)) {
    SYSTEM_TONE.lastIndex = 0;
    const tone = SYSTEM_TONE.exec(text);
    if (tone) {
      findings.push(finding('G13', ERROR, '角色文案里出现系统腔（Rule §7-2）', {
        file: normalized,
        line: lineOf(text, tone.index),
      }));
    }
  }

  const replacement = text.indexOf('\uFFFD');
  if (replacement >= 0) {
    findings.push(finding('G14', WARN, '文件含替换字符 U+FFFD，多半是编码被写坏了', {
      file: normalized,
      line: lineOf(text, replacement),
    }));
  }

  return findings;
}

// ---------------------------------------------------------------- 分支与票

const BRANCH_OK = /^(?:ticket-\d+-[\w-]+|fix-[\w-]+|chore[/-][\w-]+|docs?[/-][\w-]+)$/;

export function branchTicketNumber(branch) {
  const match = /^ticket-(\d+)-/.exec(branch);
  return match ? match[1] : null;
}

/**
 * @param {{ branch: string, allowMain?: boolean, base?: string }} context
 */
export function checkBranch({ branch, allowMain = false }) {
  const findings = [];

  if (branch === 'main' || branch === 'master') {
    findings.push(finding(
      'G20',
      allowMain ? WARN : ERROR,
      allowMain ? '直接在 main 上改（已声明允许多文档改动）' : 'main 只接受合并（Rule §7-22）；切 ticket-NN-* / fix-* 分支',
    ));
    return findings;
  }

  if (!BRANCH_OK.test(branch)) {
    findings.push(finding('G21', WARN, `分支名不合 Workflow §2：应形如 ticket-NN-<slug> / fix-<slug> / chore/<slug>`));
  }

  return findings;
}

/**
 * 票文件解析。不做格式强校验——票是给人读的，这里只取关票需要的三个事实。
 * @param {string} text 票全文
 */
export function parseTicket(text) {
  const status = /\*\*Status:\*\*\s*([a-z-]+)/i.exec(text)?.[1] ?? null;
  const title = /^#\s*\d*:?\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const blockedBy = /\*\*Blocked by:\*\*\s*(.+)/i.exec(text)?.[1]?.trim() ?? null;
  const whatToBuild = /\*\*What to build:\*\*\s*([\s\S]*?)(?:\n\*\*|\n##|$)/i.exec(text)?.[1]?.trim() ?? null;

  const notesStart = text.search(/^##\s*Notes/m);
  const notesText = notesStart >= 0 ? text.slice(notesStart) : '';

  const acceptance = [];
  const acceptanceStart = text.search(/^##\s*验收项/m);
  if (acceptanceStart >= 0) {
    const rest = text.slice(acceptanceStart);
    const end = rest.slice(1).search(/^##\s/m);
    const block = end >= 0 ? rest.slice(0, end + 1) : rest;
    for (const line of block.split('\n')) {
      const match = /^\s*-\s*\[( |x|X)\]\s*(.+)$/.exec(line);
      if (match) acceptance.push({ checked: match[1].toLowerCase() === 'x', text: match[2].trim() });
    }
  }

  return {
    title,
    status,
    blockedBy,
    whatToBuild,
    notesText,
    acceptance,
    unchecked: acceptance.filter((item) => !item.checked),
    hasNotes: notesStart >= 0,
    declaresNoConsent: /同意项[:：]\s*无/.test(text),
  };
}

/**
 * 关票与提 PR 的前置条件（Workflow §8、§9）。
 * @param {{ ticket: ReturnType<typeof parseTicket>, path: string, stage: string }} context
 */
export function checkTicket({ ticket, path: ticketPath, stage }) {
  const findings = [];
  const strict = stage === 'pr';

  if (!ticket) {
    findings.push(finding('G22', ERROR, 'ticket 分支找不到对应票文件'));
    return findings;
  }

  if (ticket.status !== 'done') {
    findings.push(finding('G23', strict ? ERROR : WARN, `票的 Status 还是 ${ticket.status ?? '(缺失)'}，关票后才提 PR（Workflow §8）`, { file: ticketPath }));
  }

  if (ticket.unchecked.length > 0) {
    findings.push(finding(
      'G24',
      strict ? ERROR : WARN,
      `${ticket.unchecked.length} 条验收项没勾：${ticket.unchecked.map((item) => item.text.slice(0, 24)).join('；')}`,
      { file: ticketPath },
    ));
  }

  if (!ticket.hasNotes) {
    findings.push(finding('G25', strict ? ERROR : WARN, '票末缺 ## Notes（Workflow §8 第三步）', { file: ticketPath }));
  }

  return findings;
}

const COMMIT_SUBJECT = /^(?:feat|fix|chore|docs|refactor|test|perf|build|ci|revert)(?:\([\w./-]+\))?: \S/;

export function checkCommitSubjects(commits) {
  const findings = [];
  for (const commit of commits) {
    if (!COMMIT_SUBJECT.test(commit.subject)) {
      findings.push(finding('G27', ERROR, `commit 标题不合规范：${commit.subject}`, { hint: commit.hash.slice(0, 7) }));
    }
  }
  return findings;
}

/** 有代码改动却没有测试改动——提示而不是拦，hotfix 与纯文档改动都会走到这里。 */
export function checkTestCoverage(files, { hotfix = false } = {}) {
  const findings = [];
  const touchedCode = files.filter((file) => /^src\/.*\.js$/.test(file.replaceAll('\\', '/')));
  const touchedTest = files.some((file) => /^test\//.test(file.replaceAll('\\', '/')));
  const touchedTool = files.some((file) => /^tools\//.test(file.replaceAll('\\', '/')));

  if (touchedCode.length > 0 && !touchedTest && !touchedTool && !hotfix) {
    findings.push(finding('G26', WARN, `改了 ${touchedCode.length} 个 src 文件但没有 test/ 改动（Workflow §5：先红后绿）`));
  }

  return findings;
}

/** 一票一分支：改动散在太多模块通常是票粒度不对（Workflow §12.3）。 */
export function checkScope(files) {
  const modules = new Set();
  for (const file of files) {
    const match = /^src\/([\w-]+)\//.exec(file.replaceAll('\\', '/'));
    if (match) modules.add(match[1]);
  }
  if (modules.size >= 6) {
    return [finding('G28', WARN, `改动跨 ${modules.size} 个 src 模块（${[...modules].join('、')}），确认这是一张票而不是三张`)];
  }
  return [];
}

export function ticketPath(branch, listIssueFiles) {
  const number = branchTicketNumber(branch);
  if (!number) return null;
  return listIssueFiles(number) ?? null;
}

export function ticketDisplayName(file) {
  return path.basename(file, '.md');
}
