import { AppError } from '../errors.js';
import { parseCardText } from '../cards/parse.js';

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;
const MAX_MESSAGE_CHARS = 4000;
const RECENT_CONTEXT_MESSAGES = 40;

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 2));
}

function llmRole(role) {
  if (role === 'char') {
    return 'assistant';
  }
  if (role === 'system_note') {
    return 'system';
  }
  return 'user';
}

function messageView(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    is_proactive: row.is_proactive,
    bubble_index: row.bubble_index,
    incomplete: row.incomplete,
    created_at: row.created_at,
  };
}

function allocateTokens(bubbles, total) {
  const weights = bubbles.map((bubble) => Math.max(1, bubble.length));
  const sum = weights.reduce((left, right) => left + right, 0);
  const result = [];
  let assigned = 0;
  for (let index = 0; index < bubbles.length; index += 1) {
    if (index === bubbles.length - 1) {
      result.push(Math.max(0, total - assigned));
      continue;
    }
    const amount = Math.max(0, Math.round((total * weights[index]) / sum));
    result.push(amount);
    assigned += amount;
  }
  return result;
}

/**
 * 对话编排：落用户消息 → 组装上下文 → 流式生成 → 后置过滤 → 逐气泡落库 → 结算。
 *
 * @param {{
 *   store: object,
 *   clock: import('../clock/index.js').Clock,
 *   config: object,
 *   llm: object,
 *   style: object,
 *   quota: object,
 *   session?: object,
 *   memory?: object,
 *   bus: object,
 *   log?: object,
 * }} options
 */
export function createChat({
  store,
  clock,
  config,
  llm,
  style,
  quota,
  session: sessionService,
  memory,
  bus,
  log,
}) {
  function requireSession(sessionId) {
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError('session_not_found', '没有找到这段会话', { status: 404 });
    }
    const session = store.sessions.findById(id);
    if (!session) {
      throw new AppError('session_not_found', '没有找到这段会话', { status: 404 });
    }
    return session;
  }

  function requireCard(session) {
    if (!session.character_id) {
      throw new AppError('session_orphaned', '这段会话没有角色卡了', { status: 404 });
    }
    const card = store.characters.findById(session.character_id);
    if (!card) {
      throw new AppError('session_orphaned', '这段会话没有角色卡了', { status: 404 });
    }
    return card;
  }

  function characterOf(card) {
    const parsed = parseCardText(card.card_json);
    return { ...parsed, id: card.id };
  }

  function sessionServiceRecovered(sessionId) {
    try {
      return sessionService?.isRecovered ? sessionService.isRecovered(sessionId) : false;
    } catch (err) {
      log?.warn('chat_recovered_check_failed', {
        session_id: sessionId,
        message: err?.message ?? String(err),
      });
      return false;
    }
  }

  /**
   * 倒序取、正序返；`before` 是上一页最小 id。
   *
   * @param {number} sessionId
   * @param {{ before?: number | null, limit?: number }} [options]
   */
  function history(sessionId, { before = null, limit = DEFAULT_HISTORY_LIMIT } = {}) {
    const session = requireSession(sessionId);

    let beforeId = null;
    if (before !== null && before !== undefined) {
      const value = Number(before);
      if (!Number.isInteger(value) || value <= 0) {
        throw new AppError('invalid_pagination', '分页参数不对', { status: 400 });
      }
      beforeId = value;
    }

    const requested = Number(limit);
    const safeLimit = Number.isFinite(requested)
      ? Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.trunc(requested)))
      : DEFAULT_HISTORY_LIMIT;

    const rows = store.messages.listForSession(session.id, {
      before: beforeId,
      limit: safeLimit,
    });

    return { messages: rows.reverse().map(messageView) };
  }

  /**
   * 人设 + 最近摘要 + pending facts + 最近原文。
   * 裁剪顺序：先丢最旧原文 → 再丢 facts → 摘要永不丢。
   *
   * @param {number} sessionId
   * @param {'chat' | 'proactive'} [kind]
   */
  function buildContext(sessionId, kind = 'chat') {
    const session = requireSession(sessionId);
    const card = requireCard(session);
    const character = characterOf(card);

    const summaryRows = store.summaries.listRecent(session.id, 3).reverse();
    const factRows = store.facts.listPending(session.id, 5);
    const recentRows = store.messages
      .listForSession(session.id, { limit: RECENT_CONTEXT_MESSAGES })
      .reverse();

    const system = style.systemPrompt(character, {
      pauseGapHours: session.pause_gap_hours,
      recovered: sessionServiceRecovered(session.id),
      coldStart: session.cold_start_silenced === 1,
    });

    const summaryMessages = summaryRows.map((row) => ({
      role: 'system',
      content: `【以前的摘要】${row.content}`,
    }));
    const factMessages = factRows.map((row) => ({
      role: 'system',
      content: `【已知事实】${row.subject}/${row.key}：${row.value}`,
    }));
    const recentMessages = recentRows.map((row) => ({
      role: llmRole(row.role),
      content: row.content,
    }));

    const context = [
      { role: 'system', content: system },
      ...summaryMessages,
      ...factMessages,
      ...recentMessages,
    ];

    const budget = Number(config.llm.context_budget) || 8000;
    let tokens = context.reduce((total, message) => total + estimateTokens(message.content), 0);
    let recentCount = recentMessages.length;
    let factCount = factMessages.length;

    while (tokens > budget && recentCount > 1) {
      const index = 1 + summaryMessages.length + factCount;
      tokens -= estimateTokens(context[index].content);
      context.splice(index, 1);
      recentCount -= 1;
    }

    while (tokens > budget && factCount > 0) {
      const index = 1 + summaryMessages.length + factCount - 1;
      tokens -= estimateTokens(context[index].content);
      context.splice(index, 1);
      factCount -= 1;
    }

    if (tokens > budget) {
      log?.warn('chat_context_over_budget', {
        session_id: session.id,
        kind,
        tokens,
        budget,
      });
    }

    return { messages: context, tokens };
  }

  async function collectStream(messages, timeoutMs) {
    let text = '';
    let usage = null;
    for await (const event of llm.chatStream({ messages, timeoutMs })) {
      if (typeof event.delta === 'string') {
        text += event.delta;
      }
      if (Object.hasOwn(event, 'usage')) {
        usage = event.usage;
      }
    }
    return { text, usage };
  }

  /**
   * 先产出 `user_ack`，再产出 `bubble`* 与 `done`。
   * 前置错误在第一次 `next()` 时抛出，HTTP 层可以据此回 4xx JSON。
   *
   * @param {number} sessionId
   * @param {string} rawText
   */
  async function* send(sessionId, rawText) {
    const session = requireSession(sessionId);
    const text = typeof rawText === 'string' ? rawText.trim() : '';

    if (text === '') {
      throw new AppError('message_empty', '说点什么再发送', { status: 400 });
    }
    if (text.length > MAX_MESSAGE_CHARS) {
      throw new AppError('message_too_long', '这段话太长了，分几次说吧', { status: 400 });
    }
    if (session.state === 'unstarted') {
      throw new AppError('session_not_started', '还没开始聊天', { status: 409 });
    }
    if (sessionService) {
      if (!sessionService.canGenerate(session.id)) {
        throw new AppError('session_cannot_generate', '她现在不太方便', { status: 409 });
      }
    } else {
      if (session.state === 'dormant') {
        throw new AppError('session_cannot_generate', '她现在不太方便', { status: 409 });
      }
      const before = quota.evaluate(session.id);
      if (before.exhausted) {
        throw new AppError('session_cannot_generate', '这段对话的额度用完了', { status: 409 });
      }
    }

    requireCard(session);

    const createdAt = clock.iso();
    let userMessageId = null;
    store.tx(() => {
      userMessageId = store.messages.insert({
        sessionId: session.id,
        role: 'user',
        content: text,
        createdAt,
      });
      store.sessions.markUserMessage(session.id, createdAt);
    });

    const userMessage = {
      id: userMessageId,
      role: 'user',
      content: text,
      is_proactive: 0,
      bubble_index: null,
      incomplete: 0,
      created_at: createdAt,
    };
    bus.emit('message', { session_id: session.id, message: userMessage });
    yield {
      type: 'user_ack',
      message_id: userMessageId,
      created_at: createdAt,
      clock_text: clock.localClockText(createdAt),
      local_day: clock.localDayOfIso(createdAt),
    };

    const context = buildContext(session.id, 'chat');
    let generated = await collectStream(context.messages, config.llm.chat_timeout_ms);

    let processed = style.postProcess(generated.text);
    let regenerated = false;
    let truncated = false;

    if (processed.blocked.length > 0) {
      regenerated = true;
      const retryMessages = [
        context.messages[0],
        {
          role: 'system',
          content: '刚才那句像客服，不像你。换成人话，短一点，别解释，也别提额度或系统。',
        },
        ...context.messages.slice(1),
      ];
      generated = await collectStream(retryMessages, config.llm.chat_timeout_ms);
      processed = style.postProcess(generated.text);

      if (processed.blocked.length > 0) {
        truncated = true;
        log?.warn('chat_style_truncated', {
          session_id: session.id,
          blocked: processed.blocked.map((item) => item.code),
        });
      }
    }

    if (processed.bubbles.length === 0) {
      throw new AppError('style_blocked', '她这次没说出合适的话，请再试一次', { status: 502 });
    }

    const promptText = context.messages.map((message) => message.content).join('');
    const reportedTokens = Number(generated.usage?.total_tokens);
    const estimated = !Number.isFinite(reportedTokens) || reportedTokens <= 0;
    const totalTokens = estimated
      ? estimateTokens(promptText + processed.bubbles.join(''))
      : Math.round(reportedTokens);
    const bubbleTokens = allocateTokens(processed.bubbles, totalTokens);
    const styleFlags = JSON.stringify({
      split: processed.flags.split,
      blacklist: processed.flags.blacklist,
      regenerated,
      truncated,
    });

    const inserted = [];
    let recorded = null;
    const batchAt = clock.iso();

    store.tx(() => {
      for (const [index, bubble] of processed.bubbles.entries()) {
        const id = store.messages.insert({
          sessionId: session.id,
          role: 'char',
          content: bubble,
          bubbleIndex: index,
          tokens: bubbleTokens[index],
          estimated: estimated ? 1 : 0,
          styleFlags,
          createdAt: batchAt,
        });
        inserted.push({
          id,
          bubble_index: index,
          text: bubble,
          created_at: batchAt,
        });
      }

      recorded = quota.record(session.id, 'chat', totalTokens, {
        estimated: estimated ? 1 : 0,
        refType: 'message',
        refId: inserted[0]?.id ?? null,
      });
      if (sessionService?.clearPauseGap) {
        sessionService.clearPauseGap(session.id);
      }
    });

    if (recorded?.exhausted && sessionService?.transition) {
      sessionService.transition(session.id, 'exhaust');
    }

    if (memory) {
      const messageIds = [userMessageId, ...inserted.map((item) => item.id)];
      void memory.extract(session.id, messageIds);
      void memory.summarize(session.id);
    }

    for (const item of inserted) {
      bus.emit('message', {
        session_id: session.id,
        message: {
          id: item.id,
          role: 'char',
          content: item.text,
          is_proactive: 0,
          bubble_index: item.bubble_index,
          incomplete: 0,
          created_at: item.created_at,
        },
      });
    }

    if (recorded?.warnFirst) {
      bus.emit('quota', {
        session_id: session.id,
        used: recorded.used,
        limit: recorded.limit,
        ratio: recorded.ratio,
        warn: recorded.warn,
      });
    }

    for (const item of inserted) {
      yield {
        type: 'bubble',
        message_id: item.id,
        bubble_index: item.bubble_index,
        text: item.text,
        incomplete: false,
        created_at: item.created_at,
        clock_text: clock.localClockText(item.created_at),
        local_day: clock.localDayOfIso(item.created_at),
      };
    }

    yield {
      type: 'done',
      tokens: totalTokens,
      estimated,
      quota: {
        used: recorded.used,
        limit: recorded.limit,
        ratio: recorded.ratio,
        warn: recorded.warn,
        exhausted: recorded.exhausted,
        status: recorded.status,
      },
    };
  }

  return { history, buildContext, send };
}
