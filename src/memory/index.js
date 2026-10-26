import { AppError } from '../errors.js';

const SUMMARY_ROUNDS = 20;
const MAX_FACT_KEY = 80;
const MAX_FACT_VALUE = 500;
const MAX_FACTS_PER_EXTRACT = 5;
const MAX_SUMMARY_CHARS = 300;
const MAX_TRANSCRIPT_CHARS = 8000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

const EXTRACT_SCHEMA = {
  type: 'object',
  required: ['found', 'facts'],
  properties: {
    found: { type: 'boolean' },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['subject', 'key', 'value'],
        properties: {
          subject: { type: 'string', enum: ['user', 'char', 'world'] },
          key: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
  },
};

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['summary'],
  properties: {
    summary: { type: 'string' },
  },
};

const EXTRACT_SYSTEM = [
  '你是记忆抽取器。只从下面这段对话里抽取“以后还可能用得上”的事实。',
  '每条事实写成 subject + key + value：subject 只能是 user / char / world；key 用简短、稳定的词；value 保留原意。',
  '不要推测，不要记寒暄、一次性的情绪、临时安排，也不要把角色扮演里的客套话当成事实。',
  '没有值得记的就返回 {"found":false,"facts":[]}。最多 5 条。只返回 JSON。',
].join('\n');

const SUMMARY_SYSTEM = [
  '你是对话摘要器。把下面这段对话压成不超过 300 字的中文摘要。',
  '保留人物、事件、约定、情绪变化和没做完的事；不要编造，不要写“用户和角色进行了对话”这种空话。',
  '只返回 JSON：{"summary":"..."}。',
].join('\n');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function transcriptOf(rows) {
  const lines = rows.map((row) => {
    const who = row.role === 'user' ? '用户' : row.role === 'char' ? '角色' : '系统';
    return `${who}：${row.content}`;
  });
  const text = lines.join('\n');
  return text.length > MAX_TRANSCRIPT_CHARS
    ? text.slice(text.length - MAX_TRANSCRIPT_CHARS)
    : text;
}

function normalizeFact(raw) {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const subject = raw.subject;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  const value = typeof raw.value === 'string' ? raw.value.trim() : '';
  if (!['user', 'char', 'world'].includes(subject) || key === '' || value === '') {
    return null;
  }
  if (key.length > MAX_FACT_KEY || value.length > MAX_FACT_VALUE) {
    return null;
  }
  return { subject, key, value };
}

/**
 * 记忆是尽力而为：所有失败只记日志，不把异常抛回对话。
 *
 * @param {{
 *   store: object,
 *   clock: import('../clock/index.js').Clock,
 *   llm: object,
 *   log?: object,
 * }} options
 */
export function createMemory({ store, clock, llm, log }) {
  const extracting = new Set();
  const summarizing = new Set();

  function requireSession(sessionId) {
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError('session_not_found', '没有找到这段会话', { status: 404 });
    }
    const session = store.sessions.findById(id);
    if (!session) {
      throw new AppError('session_not_found', '没有找到这段会话', { status: 404 });
    }
    return id;
  }

  /**
   * 一轮结束后异步抽取事实；同一会话同时只跑一个抽取，避免写重。
   *
   * @param {number} sessionId
   * @param {number[]} msgIds
   */
  async function extract(sessionId, msgIds) {
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id <= 0 || extracting.has(id)) {
      return null;
    }
    extracting.add(id);

    try {
      const ids = [...new Set(
        (Array.isArray(msgIds) ? msgIds : [])
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0),
      )];
      if (ids.length === 0) {
        return null;
      }

      const rows = store.messages.listByIds(id, ids);
      if (rows.length === 0) {
        return null;
      }

      const { value } = await llm.json({
        system: EXTRACT_SYSTEM,
        user: transcriptOf(rows),
        schema: EXTRACT_SCHEMA,
        retry: false,
      });
      if (value?.found !== true || !Array.isArray(value.facts)) {
        return null;
      }

      const at = clock.iso();
      const sourceMsgId = rows.filter((row) => row.role === 'user').at(-1)?.id
        ?? rows.at(-1).id;
      const saved = [];

      for (const raw of value.facts.slice(0, MAX_FACTS_PER_EXTRACT)) {
        const fact = normalizeFact(raw);
        if (fact === null) {
          continue;
        }

        store.tx(() => {
          const active = store.facts.findActive(id, fact.subject, fact.key);
          if (active !== null && active.value === fact.value) {
            store.facts.touch(active.id, at);
            saved.push({ ...active, status: 'pending', valid_from: at });
            return;
          }
          if (active !== null) {
            store.facts.close(active.id, at);
          }
          const factId = store.facts.insert({
            sessionId: id,
            subject: fact.subject,
            key: fact.key,
            value: fact.value,
            status: 'pending',
            validFrom: at,
            sourceMsgId,
          });
          saved.push({
            id: factId,
            session_id: id,
            subject: fact.subject,
            key: fact.key,
            value: fact.value,
            status: 'pending',
            valid_from: at,
            valid_to: null,
            source_msg_id: sourceMsgId,
          });
        });
      }

      return saved;
    } catch (err) {
      log?.warn('memory_extract_failed', {
        session_id: id,
        code: err?.code ?? 'unknown',
        message: err?.message ?? String(err),
      });
      return null;
    } finally {
      extracting.delete(id);
    }
  }

  /**
   * 每满 20 个用户轮次生成一条摘要；同一会话同时只跑一个摘要。
   *
   * @param {number} sessionId
   */
  async function summarize(sessionId) {
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id <= 0 || summarizing.has(id)) {
      return null;
    }
    summarizing.add(id);

    try {
      const last = store.summaries.lastForSession(id);
      const afterId = Number(last?.to_msg_id ?? 0);
      const rows = store.messages.listAfter(id, afterId);
      const userRows = rows.filter((row) => row.role === 'user');
      if (userRows.length < SUMMARY_ROUNDS) {
        return null;
      }

      const boundary = userRows[SUMMARY_ROUNDS - 1];
      let toId = boundary.id;
      for (const row of rows) {
        if (row.id <= boundary.id) {
          continue;
        }
        if (row.role === 'user') {
          break;
        }
        toId = row.id;
      }

      const included = rows.filter((row) => row.id <= toId);
      if (included.length === 0) {
        return null;
      }

      const { value } = await llm.json({
        system: SUMMARY_SYSTEM,
        user: transcriptOf(included),
        schema: SUMMARY_SCHEMA,
        retry: false,
      });
      const content = typeof value?.summary === 'string'
        ? value.summary.trim().slice(0, MAX_SUMMARY_CHARS)
        : '';
      if (content === '') {
        return null;
      }

      const fromId = included[0].id;
      const summaryId = store.summaries.insert({
        sessionId: id,
        fromMsgId: fromId,
        toMsgId: toId,
        content,
        createdAt: clock.iso(),
      });
      return {
        id: summaryId,
        session_id: id,
        from_msg_id: fromId,
        to_msg_id: toId,
        content,
      };
    } catch (err) {
      log?.warn('memory_summarize_failed', {
        session_id: id,
        code: err?.code ?? 'unknown',
        message: err?.message ?? String(err),
      });
      return null;
    } finally {
      summarizing.delete(id);
    }
  }

  /**
   * @param {number} sessionId
   */
  function list(sessionId) {
    const id = requireSession(sessionId);
    return {
      facts: store.facts.listAll(id),
      summaries: store.summaries.listAll(id),
    };
  }

  /**
   * @param {number} id
   * @returns {boolean} 是否真的删掉了一行
   */
  function removeFact(id) {
    const factId = Number(id);
    if (!Number.isInteger(factId) || factId <= 0) {
      return false;
    }
    return store.facts.remove(factId) > 0;
  }

  /**
   * 关键词检索包含过期事实，用于“翻旧账”；不向量化。
   *
   * @param {number} sessionId
   * @param {string} query
   * @param {number} [limit=5]
   */
  function search(sessionId, query, limit = DEFAULT_SEARCH_LIMIT) {
    const id = requireSession(sessionId);
    const text = typeof query === 'string' ? query.trim() : '';
    if (text === '') {
      return { facts: [], summaries: [] };
    }
    const requested = Number(limit);
    const safeLimit = Number.isFinite(requested)
      ? clamp(Math.trunc(requested), 1, MAX_SEARCH_LIMIT)
      : DEFAULT_SEARCH_LIMIT;
    const pattern = `%${text}%`;
    return {
      facts: store.facts.search(id, pattern, safeLimit),
      summaries: store.summaries.search(id, pattern, safeLimit),
    };
  }

  return { extract, summarize, list, removeFact, search };
}
