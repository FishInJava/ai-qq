import { AppError } from '../errors.js';
import { parseCardText } from '../cards/parse.js';

const MAX_EVENT_CHARS = 80;
const MAX_PERSONA_CHARS = 2000;
const MAX_EVENTS = 3;

const FEED_LABELS = Object.freeze({
  weather: '天气',
  holiday: '节日',
  news: '新闻',
});

const EVENTS_SCHEMA = {
  type: 'object',
  required: ['events'],
  properties: {
    events: {
      type: 'array',
      minItems: 2,
      maxItems: MAX_EVENTS,
      items: { type: 'string' },
    },
  },
};

const CONFLICTS_SCHEMA = {
  type: 'object',
  required: ['conflicts'],
  properties: {
    conflicts: {
      type: 'array',
      items: { type: 'integer' },
    },
  },
};

const EVENTS_SYSTEM = [
  '你在替一个角色写“她今天的生活”。',
  '写 2–3 条彼此独立的小事：做了什么、看到什么、心情的一个小转折。',
  '只写今天，不写天气播报，不评论新闻，不提 AI、系统、用户，也不写“和用户聊天”。',
  '每条一句话，不超过 40 字。只返回 JSON：{"events":["...","..."]}。',
].join('\n');

const CONFLICTS_SYSTEM = [
  '你是人设一致性检查器。',
  '下面给出角色资料和几条“她今天的生活”候选事件。',
  '找出与角色设定明显冲突的事件序号（从 0 开始）：性格不符、身份不符、世界观不符、或明显不可能发生。',
  '只返回 JSON：{"conflicts":[序号...]}；没有冲突就返回空数组。',
].join('\n');

function requireSessionId(store, value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('session_not_found', '没有找到这段会话', { status: 404 });
  }
  if (!store.sessions.findById(id)) {
    throw new AppError('session_not_found', '没有找到这段会话', { status: 404 });
  }
  return id;
}

function personaOf(character) {
  return [
    `名字：${character.name}`,
    character.description ? `描述：${character.description}` : '',
    character.personality ? `性格：${character.personality}` : '',
    character.scenario ? `场景：${character.scenario}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_PERSONA_CHARS);
}

function feedLines(feeds) {
  const lines = feeds.map((row) => `${FEED_LABELS[row.kind] ?? row.kind}：${row.content}`);
  return lines.length === 0 ? '（今天没有额外的天气 / 节日 / 新闻素材）' : lines.join('\n');
}

function normalizeEvents(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set();
  const events = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      continue;
    }
    const text = item.replace(/\s+/g, ' ').trim().slice(0, MAX_EVENT_CHARS);
    if (text === '' || seen.has(text)) {
      continue;
    }
    seen.add(text);
    events.push(text);
    if (events.length === MAX_EVENTS) {
      break;
    }
  }
  return events;
}

export function createLiving({ store, clock, llm, feeds, log }) {
  const generating = new Set();

  async function generateEvents(persona, feedRows, avoid = []) {
    const user = [
      `角色资料：\n${persona}`,
      `今日素材：\n${feedLines(feedRows)}`,
      avoid.length === 0 ? '' : `这些候选与角色冲突，请换掉：\n${avoid.join('\n')}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const { value } = await llm.json({
      system: EVENTS_SYSTEM,
      user,
      schema: EVENTS_SCHEMA,
      retry: false,
    });
    return normalizeEvents(value?.events);
  }

  async function findConflicts(persona, events) {
    const user = [
      `角色资料：\n${persona}`,
      `候选事件：\n${events.map((event, index) => `${index}. ${event}`).join('\n')}`,
    ].join('\n\n');
    const { value } = await llm.json({
      system: CONFLICTS_SYSTEM,
      user,
      schema: CONFLICTS_SCHEMA,
      retry: false,
    });
    const raw = Array.isArray(value?.conflicts) ? value.conflicts : [];
    return [...new Set(
      raw
        .map((index) => Number(index))
        .filter((index) => Number.isInteger(index) && index >= 0 && index < events.length),
    )];
  }

  async function compose(character, feedRows) {
    const persona = personaOf(character);
    let events = await generateEvents(persona, feedRows);
    if (events.length === 0) {
      return [];
    }

    let conflicts = await findConflicts(persona, events);
    if (conflicts.length === 0) {
      return events;
    }

    const rewritten = await generateEvents(
      persona,
      feedRows,
      conflicts.map((index) => events[index]),
    );
    const filled = new Set();
    for (const index of conflicts) {
      const replacement = rewritten.shift();
      if (replacement === undefined) {
        continue;
      }
      events[index] = replacement;
      filled.add(index);
    }
    const unfilled = conflicts.filter((index) => !filled.has(index));
    if (unfilled.length > 0) {
      events = events.filter((_, index) => !unfilled.includes(index));
    }

    conflicts = await findConflicts(persona, events);
    if (conflicts.length > 0) {
      events = events.filter((_, index) => !conflicts.includes(index));
    }
    return events.slice(0, MAX_EVENTS);
  }

  async function ensureToday(sessionId) {
    const id = requireSessionId(store, sessionId);
    const day = clock.localDay();
    const existing = store.lifeEvents.listForDay(id, day);
    if (existing.length > 0 || generating.has(id)) {
      return existing;
    }

    generating.add(id);
    try {
      const session = store.sessions.findById(id);
      if (!session || session.state === 'unstarted' || session.character_id === null) {
        return existing;
      }
      const card = store.characters.findById(session.character_id);
      if (!card) {
        return existing;
      }

      const character = { ...parseCardText(card.card_json), id: card.id };
      const events = await compose(character, store.worldFeeds.listForDay(day));
      if (events.length === 0) {
        return existing;
      }

      const createdAt = clock.iso();
      store.tx(() => {
        events.forEach((content, index) => {
          store.lifeEvents.insert({
            sessionId: id,
            eventDate: day,
            ordinal: index + 1,
            content,
            createdAt,
          });
        });
      });
      return store.lifeEvents.listForDay(id, day);
    } catch (err) {
      log?.warn('living_events_failed', {
        session_id: id,
        code: err?.code ?? 'unknown',
        message: err?.message ?? String(err),
      });
      return store.lifeEvents.listForDay(id, clock.localDay());
    } finally {
      generating.delete(id);
    }
  }

  async function ensureFeeds() {
    try {
      await feeds.ensureDay(clock.localDay());
    } catch (err) {
      log?.warn('living_feeds_failed', {
        message: err?.message ?? String(err),
      });
    }
  }

  async function ensureEvents() {
    for (const session of store.sessions.listAll()) {
      if (session.state === 'unstarted') {
        continue;
      }
      try {
        await ensureToday(session.id);
      } catch (err) {
        log?.warn('living_events_failed', {
          session_id: session.id,
          message: err?.message ?? String(err),
        });
      }
    }
  }

  async function ensureAll() {
    await ensureFeeds();
    await ensureEvents();
  }

  async function today(sessionId) {
    const id = requireSessionId(store, sessionId);
    await ensureToday(id);
    const day = clock.localDay();
    return {
      date: day,
      events: store.lifeEvents.listForDay(id, day),
      feeds: store.worldFeeds.listForDay(day),
    };
  }

  return { ensureToday, ensureAll, ensureFeeds, ensureEvents, today };
}
