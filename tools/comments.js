const PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'catch', 'with']);
const OP_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const LANGUAGES = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.html': 'html',
  '.css': 'css',
  '.sql': 'sql',
  '.ps1': 'ps1',
};

export function languageOf(file) {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? null : LANGUAGES[file.slice(dot).toLowerCase()] ?? null;
}

export function findComments(text, language) {
  const found = [];
  if (language === 'js') {
    scanJs(text, 0, text.length, found, false);
  } else if (language === 'html') {
    scanHtml(text, found);
  } else if (language === 'css') {
    scanBlockComments(text, 0, text.length, found);
  } else if (language === 'sql') {
    scanSql(text, found);
  } else if (language === 'ps1') {
    scanPs1(text, found);
  } else {
    throw new Error(`未知语言：${language}`);
  }
  return found;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

function endOfLine(text, index) {
  const found = text.indexOf('\n', index);
  return found === -1 ? text.length : found;
}

function skipString(text, index, end) {
  const quote = text[index];
  let i = index + 1;
  while (i < end) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    if (ch === '\n') {
      return i;
    }
    i += 1;
  }
  return end;
}

function skipRegex(text, index, end) {
  let i = index + 1;
  let inClass = false;
  while (i < end) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === ']') {
      inClass = false;
      i += 1;
      continue;
    }
    if (ch === '/' && !inClass) {
      i += 1;
      while (i < end && /[a-z]/i.test(text[i])) {
        i += 1;
      }
      return i;
    }
    if (ch === '\n') {
      return i;
    }
    i += 1;
  }
  return end;
}

function skipTemplate(text, index, end, found) {
  let i = index + 1;
  while (i < end) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      return i + 1;
    }
    if (ch === '$' && text[i + 1] === '{') {
      i = scanJs(text, i + 2, end, found, true);
      continue;
    }
    i += 1;
  }
  return end;
}

function scanJs(text, start, end, found, stopAtBrace) {
  let i = start;
  let prev = 'op';
  let depth = 0;
  const parens = [];

  if (text.startsWith('#!', start)) {
    i = endOfLine(text, start);
  }

  while (i < end) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      const stop = endOfLine(text, i);
      found.push({ start: i, end: stop, line: lineAt(text, i) });
      i = stop;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 || close + 2 > end ? end : close + 2;
      found.push({ start: i, end: stop, line: lineAt(text, i) });
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'") {
      i = skipString(text, i, end);
      prev = 'value';
      continue;
    }

    if (ch === '`') {
      i = skipTemplate(text, i, end, found);
      prev = 'value';
      continue;
    }

    if (ch === '/' && prev === 'op') {
      i = skipRegex(text, i, end);
      prev = 'value';
      continue;
    }

    if (ch === '(') {
      parens.push(prev === 'paren');
      prev = 'op';
      i += 1;
      continue;
    }

    if (ch === ')') {
      prev = parens.pop() === true ? 'op' : 'value';
      i += 1;
      continue;
    }

    if (ch === ']') {
      prev = 'value';
      i += 1;
      continue;
    }

    if (ch === '{') {
      depth += 1;
      prev = 'op';
      i += 1;
      continue;
    }

    if (ch === '}') {
      if (stopAtBrace && depth === 0) {
        return i + 1;
      }
      depth -= 1;
      prev = 'op';
      i += 1;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let next = i + 1;
      while (next < end && /[\w$]/.test(text[next])) {
        next += 1;
      }
      const word = text.slice(i, next);
      if (PAREN_KEYWORDS.has(word)) {
        prev = 'paren';
      } else if (OP_KEYWORDS.has(word)) {
        prev = 'op';
      } else {
        prev = 'value';
      }
      i = next;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1]))) {
      let next = i + 1;
      while (next < end && /[\w.]/.test(text[next])) {
        next += 1;
      }
      prev = 'value';
      i = next;
      continue;
    }

    if ((ch === '+' || ch === '-') && text[i + 1] === ch && prev === 'value') {
      i += 2;
      continue;
    }

    prev = 'op';
    i += 1;
  }

  return i;
}

function scanBlockComments(text, start, end, found) {
  let i = start;
  while (i < end) {
    const open = text.indexOf('/*', i);
    if (open === -1 || open >= end) {
      return;
    }
    const close = text.indexOf('*/', open + 2);
    const stop = close === -1 || close + 2 > end ? end : close + 2;
    found.push({ start: open, end: stop, line: lineAt(text, open) });
    i = stop;
  }
}

function scanHtml(text, found) {
  let i = 0;
  const lower = text.toLowerCase();
  while (i < text.length) {
    const open = text.indexOf('<', i);
    if (open === -1) {
      return;
    }
    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4);
      const stop = close === -1 ? text.length : close + 3;
      found.push({ start: open, end: stop, line: lineAt(text, open) });
      i = stop;
      continue;
    }
    const isScript = lower.startsWith('<script', open);
    const isStyle = lower.startsWith('<style', open);
    if (isScript || isStyle) {
      const tagEnd = text.indexOf('>', open);
      if (tagEnd === -1) {
        return;
      }
      const closeTag = isScript ? '</script' : '</style';
      const close = lower.indexOf(closeTag, tagEnd + 1);
      const hasSrc = lower.slice(open, tagEnd).includes('src=');
      const bodyEnd = close === -1 ? text.length : close;
      if (!hasSrc) {
        if (isScript) {
          scanJs(text, tagEnd + 1, bodyEnd, found, false);
        } else {
          scanBlockComments(text, tagEnd + 1, bodyEnd, found);
        }
      }
      i = close === -1 ? text.length : close;
      continue;
    }
    i = open + 1;
  }
}

function scanSql(text, found) {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      i = skipString(text, i, text.length);
      continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      const stop = endOfLine(text, i);
      found.push({ start: i, end: stop, line: lineAt(text, i) });
      i = stop;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? text.length : close + 2;
      found.push({ start: i, end: stop, line: lineAt(text, i) });
      i = stop;
      continue;
    }
    i += 1;
  }
}

function scanPs1(text, found) {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      i += 1;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < text.length) {
        if (text[i] === '`') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '<' && text[i + 1] === '#') {
      const close = text.indexOf('#>', i + 2);
      const stop = close === -1 ? text.length : close + 2;
      found.push({ start: i, end: stop, line: lineAt(text, i) });
      i = stop;
      continue;
    }
    if (ch === '#') {
      const stop = endOfLine(text, i);
      const body = text.slice(i + 1, stop).trimStart().toLowerCase();
      if (body.startsWith('requires')) {
        i = stop;
        continue;
      }
      const before = text[i - 1] ?? ' ';
      if (/[A-Za-z0-9_$}\]]/.test(before) && i > 0) {
        i += 1;
        continue;
      }
      found.push({ start: i, end: stop, line: lineAt(text, i) });
      i = stop;
      continue;
    }
    i += 1;
  }
}
