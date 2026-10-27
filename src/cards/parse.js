import { AppError } from '../errors.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function nonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : value;
}

function hasScripts(extensions) {
  if (!isPlainObject(extensions)) {
    return false;
  }
  const regexScripts = extensions.regex_scripts;
  if (Array.isArray(regexScripts) && regexScripts.length > 0) {
    return true;
  }
  const scripts = extensions.scripts;
  if (Array.isArray(scripts) && scripts.length > 0) {
    return true;
  }
  if (isPlainObject(scripts) && Object.keys(scripts).length > 0) {
    return true;
  }
  return typeof extensions.stscript === 'string' && extensions.stscript.trim() !== '';
}

function hasBook(data) {
  return isPlainObject(data.character_book);
}

export function parseCardText(jsonText) {
  const text = jsonText.charCodeAt(0) === 0xfeff ? jsonText.slice(1) : jsonText;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AppError('card_json_invalid', '卡片数据损坏，解析不了', { status: 400, cause: err });
  }

  if (!isPlainObject(parsed)) {
    throw new AppError('card_json_invalid', '卡片数据损坏，解析不了', { status: 400 });
  }

  const spec = asString(parsed.spec);
  const compat = spec === 'chara_card_v2' ? 'v2' : 'v1';
  const data = isPlainObject(parsed.data) ? parsed.data : parsed;
  const extensions = isPlainObject(data.extensions)
    ? data.extensions
    : (isPlainObject(parsed.extensions) ? parsed.extensions : null);

  return {
    compat,
    name: nonEmptyString(data.name) ?? '未命名角色',
    description: asString(data.description),
    tags: Array.isArray(data.tags)
      ? data.tags.filter((tag) => typeof tag === 'string')
      : [],
    personality: asString(data.personality),
    scenario: asString(data.scenario),
    firstMes: asString(data.first_mes),
    mesExample: asString(data.mes_example),
    systemPrompt: asString(data.system_prompt),
    postHistoryInstructions: asString(data.post_history_instructions),
    extensionsJson: extensions === null ? null : JSON.stringify(extensions),
    hasScripts: hasScripts(extensions),
    hasBook: hasBook(data),
  };
}
