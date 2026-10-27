import path from 'node:path';

const CRLF_EXTENSIONS = new Set(['.ps1', '.psm1']);

export function eolFor(file) {
  return CRLF_EXTENSIONS.has(path.extname(file).toLowerCase()) ? '\r\n' : '\n';
}

export function formatText(file, text) {
  const counts = { bom: 0, eol: 0, trailing: 0, blankLines: 0, eof: 0 };
  const isMarkdown = /\.md$/i.test(file);
  let out = text;

  if (out.charCodeAt(0) === 0xFEFF) {
    out = out.slice(1);
    counts.bom = 1;
  }

  const wantsCrlf = eolFor(file) === '\r\n';
  const eolMismatch = wantsCrlf ? /(^|[^\r])\n/.test(out) : out.includes('\r\n');
  if (eolMismatch) counts.eol = 1;
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

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
