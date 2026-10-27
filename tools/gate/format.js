// 安全格式化：只做"改回去也不影响语义"的收敛。
// 明确不做：缩进、引号、分号、换行位置、import 排序。没有实测过的重排就是在替人写代码。
// 本项目零依赖（ADR-0002），所以这里不是 prettier 的替代品，是"提交前的卫生纸"。
import path from 'node:path';

// .gitattributes 把 ps1 定成 CRLF，其余定成 LF；跟着它走，不另立标准。
const CRLF_EXTENSIONS = new Set(['.ps1', '.psm1']);

export function eolFor(file) {
  return CRLF_EXTENSIONS.has(path.extname(file).toLowerCase()) ? '\r\n' : '\n';
}

/**
 * @returns {{ text: string, counts: Record<string, number> }}
 */
export function formatText(file, text) {
  const counts = { bom: 0, eol: 0, trailing: 0, blankLines: 0, eof: 0 };
  const isMarkdown = /\.md$/i.test(file);
  let out = text;

  if (out.charCodeAt(0) === 0xFEFF) {
    out = out.slice(1);
    counts.bom = 1;
  }

  // 行尾是否已经合目标：LF 文件里出现 CRLF 算不一致；CRLF 文件里出现裸 LF 也算。
  // 不用"有没有 CRLF"判断——ps1 工作区本来就是 CRLF，那样每跑一次都报假问题。
  const wantsCrlf = eolFor(file) === '\r\n';
  const eolMismatch = wantsCrlf ? /(^|[^\r])\n/.test(out) : out.includes('\r\n');
  if (eolMismatch) counts.eol = 1;
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Markdown 行尾两个空格是硬换行，不能碰；其余文件的行尾空白一律是垃圾。
  if (!isMarkdown) {
    const trimmed = out.replace(/[ \t]+$/gm, '');
    if (trimmed !== out) {
      counts.trailing = (out.match(/[ \t]+$/gm) ?? []).length;
      out = trimmed;
    }
  }

  const compacted = out.replace(/\n{3,}/g, '\n\n');
  if (compacted !== out) {
    counts.blankLines = (out.match(/\n{3,}/g) ?? []).length;
    out = compacted;
  }

  if (out.length > 0 && !out.endsWith('\n')) {
    out += '\n';
    counts.eof = 1;
  } else if (out.length > 1 && out.endsWith('\n\n')) {
    out = `${out.replace(/\n+$/, '')}\n`;
    counts.eof = 1;
  }

  const eol = eolFor(file);
  if (eol === '\r\n') {
    out = out.replace(/\n/g, '\r\n');
  }

  return { text: out, counts };
}

export function totalFixes(counts) {
  return Object.values(counts).reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0);
}

export function describeFixes(counts) {
  const labels = { bom: 'BOM', eol: '换行不一致', trailing: '行尾空白', blankLines: '多余空行', eof: '文件末尾换行' };
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([key]) => labels[key] ?? key);
}
