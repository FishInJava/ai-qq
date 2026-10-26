import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClock } from '../../src/clock/index.js';
import { createProactive } from '../../src/proactive/index.js';
import { createQuota } from '../../src/quota/index.js';
import { createSchedule } from '../../src/schedule/index.js';
import { createStyle } from '../../src/style/index.js';
import { createBus } from '../../src/runtime/bus.js';
import { openStore } from '../../src/store/index.js';

const FIXED_MS = Date.parse('2026-10-01T02:00:00.000Z');
const MINUTE_MS = 60 * 1000;

function makeConfig(overrides = {}) {
  return {
    llm: {
      chat_timeout_ms: 5000,
      context_budget: 8000,
      proactive_context_budget: 2000,
      ...(overrides.llm ?? {}),
    },
    schedule: {
      tick_min: 20,
      tick_max: 40,
      hard_trigger_hours: 6,
      cooldown_min: 15,
      willingness_threshold: 0.6,
      ignored_multiplier: 1.5,
      ...(overrides.schedule ?? {}),
    },
    budget: { daily_global: 5, per_session: 2, ...(overrides.budget ?? {}) },
    quota: { default_token_limit: 500000, warn_ratio: 0.7, ...(overrides.quota ?? {}) },
    runtime: { cold_start_proactive: true, test_hooks: false, ...(overrides.runtime ?? {}) },
    living: { feeds_time: '08:30', life_event_time: '09:00', ...(overrides.living ?? {}) },
  };
}

function makeFixture(overrides = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'companion-schedule-'));
  let current = FIXED_MS;
  const clock = createClock({ now: () => current });
  const store = openStore({ dataDir, clock });
  store.migrate();
  const config = makeConfig(overrides);

  function addCharacter(name = '阿岚') {
    return store.characters.insert({
      name,
      cardJson: JSON.stringify({
        spec: 'chara_card_v2',
        data: {
          name,
          description: '住得近，偶尔一起吃饭。',
          personality: '安静，说话短。',
          scenario: '你和她住在同一栋楼。',
        },
      }),
      extensionsJson: null,
      compat: 'v2',
      avatarPath: null,
      cardSourcePath: null,
      sourceHash: randomUUID(),
      importedAt: clock.iso(),
    });
  }

  function addSession(state = 'active') {
    return store.sessions.insert({
      characterId: addCharacter(),
      state,
      tokenLimit: 500000,
      createdAt: clock.iso(),
    });
  }

  function addEvent(sessionId, content, ordinal = 1) {
    return store.lifeEvents.insert({
      sessionId,
      eventDate: clock.localDay(),
      ordinal,
      content,
      createdAt: clock.iso(),
    });
  }

  function addFact(sessionId, key, value, subject = 'user') {
    return store.facts.insert({
      sessionId,
      subject,
      key,
      value,
      validFrom: clock.iso(),
    });
  }

  function markUser(sessionId, minutesAgo = 0) {
    store.sessions.markUserMessage(sessionId, clock.iso(clock.now() - (minutesAgo * MINUTE_MS)));
  }

  function advance(ms) {
    current += ms;
  }

  const logs = [];
  const log = {
    info(name, fields) {
      logs.push({ level: 'info', name, fields });
    },
    warn(name, fields) {
      logs.push({ level: 'warn', name, fields });
    },
  };
  const bus = createBus();
  const events = [];
  bus.subscribe((topic, payload) => events.push({ topic, payload }));
  const quota = createQuota({ store, clock, config });
  const style = createStyle();
  const proactive = createProactive({ store, clock, config, llm: null, style, quota, bus, log });

  function makeSchedule(llm) {
    const activeProactive = createProactive({ store, clock, config, llm, style, quota, bus, log });
    return createSchedule({
      store,
      clock,
      config,
      proactive: activeProactive,
      living: {
        async ensureAll() {},
        async ensureFeeds() {},
        async ensureEvents() {},
      },
      bus,
      log,
      random: () => 0.5,
    });
  }

  return {
    dataDir,
    clock,
    store,
    config,
    logs,
    bus,
    events,
    quota,
    style,
    proactive,
    addSession,
    addEvent,
    addFact,
    markUser,
    advance,
    makeSchedule,
    close() {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function firstSegment(text) {
  const clean = String(text ?? '').trim();
  const match = /^([^，。！？!?…；;]+)/.exec(clean);
  const segment = (match ? match[1] : clean).trim();
  return segment === '' ? clean : segment;
}

function replyFrom(messages) {
  const text = messages.map((message) => String(message?.content ?? '')).join('\n');
  const found = /\[(event|fact):(\d+)\]\s*([^\n]*)/.exec(text);
  if (!found) {
    return '{"bubbles":["今天有点累。"],"anchor":{"type":"event","id":999999}}';
  }
  const type = found[1];
  const id = Number(found[2]);
  const line = found[3].trim();
  let bubble;
  if (type === 'fact') {
    const value = line.split('：').slice(1).join('：').trim();
    bubble = value === '' ? firstSegment(line) : `之前你说过${value}，我一直记着。`;
  } else {
    bubble = `${firstSegment(line)}。`;
  }
  if (text.includes('台阶')) {
    bubble = `算了 你去忙吧。${bubble}`;
  }
  if (text.includes('有点累')) {
    bubble = `今天有点累。${bubble}`;
  }
  return JSON.stringify({ bubbles: [bubble.slice(0, 60)], anchor: { type, id } });
}

function scriptedLlm() {
  const calls = [];
  return {
    calls,
    async *chatStream(options) {
      calls.push(options);
      yield { delta: replyFrom(options.messages) };
      yield { usage: { total_tokens: 20 } };
      yield { done: true };
    },
  };
}

function expectedWillingness({ minutes, hasFact, used, unusedEvents, perSession, fit, ignored }) {
  const silence = Math.min(1, Math.max(0, (minutes - 15) / (360 - 15)));
  const room = perSession > 0 ? Math.max(0, 1 - used / perSession) : 0;
  const eventRoom = Math.min(1, unusedEvents / 3);
  const penalty = Math.min(ignored, 3) / 3;
  return Math.min(1, Math.max(0, (
    (0.30 * silence)
    + (0.25 * (hasFact ? 1 : 0))
    + (0.20 * room)
    + (0.15 * eventRoom)
    + (0.10 * fit)
    - (0.20 * penalty)
  )));
}

function timeFit(clock) {
  const minutes = clock.localTimeMinutes();
  if (minutes >= 8 * 60 && minutes < 23 * 60) {
    return 1;
  }
  if (minutes >= 23 * 60) {
    return Math.max(0, 1 - (minutes - 23 * 60) / 180);
  }
  return Math.max(0, 1 - (minutes + 60) / 180);
}

test('剪枝顺序：状态 → 全局预算 → 角色预算 → 冷却 → 锚点 → 意愿 → 发送', async () => {
  const fixture = makeFixture();
  try {
    const { store, config } = fixture;
    const sessionId = fixture.addSession();
    fixture.markUser(sessionId, 0);
    const schedule = fixture.makeSchedule(scriptedLlm());

    store.sessions.setState(sessionId, 'paused');
    assert.equal((await schedule.runTick(sessionId, 'manual')).reason, 'state_not_active');
    store.sessions.setState(sessionId, 'active');

    config.budget.daily_global = 0;
    assert.equal((await schedule.runTick(sessionId, 'manual')).reason, 'budget_global_full');

    config.budget.daily_global = 5;
    config.budget.per_session = 0;
    assert.equal((await schedule.runTick(sessionId, 'manual')).reason, 'budget_session_full');

    config.budget.per_session = 2;
    config.schedule.cooldown_min = 15;
    assert.equal((await schedule.runTick(sessionId, 'manual')).reason, 'too_soon');

    config.schedule.cooldown_min = 0;
    assert.equal((await schedule.runTick(sessionId, 'manual')).reason, 'no_anchor');

    fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);
    fixture.addEvent(sessionId, '楼下新开了一家面馆，傍晚排了队。', 2);
    fixture.addEvent(sessionId, '晚上煮了一碗面。', 3);
    const low = await schedule.runTick(sessionId, 'manual');
    assert.equal(low.reason, 'low_willingness');
    assert.ok(low.willingness < 0.6);

    fixture.addFact(sessionId, 'city', '杭州');
    const sent = await schedule.runTick(sessionId, 'manual');
    assert.equal(sent.decision, 'send');
    assert.equal(sent.reason, 'send');
    assert.equal(sent.guidance, null);
    assert.ok(sent.nextTickAt);

    const rows = store.schedulerState.listRecent(sessionId, 20).reverse();
    assert.deepEqual(
      rows.map((row) => row.decision_reason),
      ['state_not_active', 'budget_global_full', 'budget_session_full', 'too_soon', 'no_anchor', 'low_willingness', 'send'],
    );
    assert.ok(fixture.events.some((event) => event.topic === 'tick' && event.payload.reason === 'send'));
  } finally {
    fixture.close();
  }
});

test('意愿公式：15 分钟无事实低于阈值，3 小时且有事实明显高于阈值', () => {
  const fixture = makeFixture();
  try {
    const { clock, config } = fixture;
    const sessionId = fixture.addSession();
    fixture.markUser(sessionId, 15);
    fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);
    fixture.addEvent(sessionId, '楼下新开了一家面馆，傍晚排了队。', 2);
    fixture.addEvent(sessionId, '晚上煮了一碗面。', 3);
    const schedule = fixture.makeSchedule(scriptedLlm());

    const first = schedule.willingness(sessionId);
    const firstExpected = expectedWillingness({
      minutes: 15,
      hasFact: false,
      used: 0,
      unusedEvents: 3,
      perSession: config.budget.per_session,
      fit: timeFit(clock),
      ignored: 0,
    });
    assert.ok(Math.abs(first - firstExpected) < 1e-9);
    assert.ok(first < 0.6);

    fixture.advance(165 * MINUTE_MS);
    fixture.addFact(sessionId, 'city', '杭州');
    const second = schedule.willingness(sessionId);
    const secondExpected = expectedWillingness({
      minutes: 180,
      hasFact: true,
      used: 0,
      unusedEvents: 3,
      perSession: config.budget.per_session,
      fit: timeFit(clock),
      ignored: 0,
    });
    assert.ok(Math.abs(second - secondExpected) < 1e-9);
    assert.ok(second >= 0.6);
  } finally {
    fixture.close();
  }
});

test('硬触发只跳过冷却：30 分钟时 timer 跳过，hard 仍能发', async () => {
  const fixture = makeFixture();
  try {
    const { store } = fixture;
    const sessionId = fixture.addSession();
    fixture.markUser(sessionId, 5);
    fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);
    fixture.addEvent(sessionId, '楼下新开了一家面馆，傍晚排了队。', 2);
    fixture.addEvent(sessionId, '晚上煮了一碗面。', 3);
    fixture.addFact(sessionId, 'city', '杭州');
    const llm = scriptedLlm();
    const schedule = fixture.makeSchedule(llm);

    assert.equal((await schedule.runTick(sessionId, 'timer')).reason, 'too_soon');
    const sent = await schedule.runTick(sessionId, 'hard');
    assert.equal(sent.decision, 'send');
    assert.equal(sent.trigger, 'hard');
    assert.equal(llm.calls.length, 1);
    assert.equal(store.budget.usedOn(fixture.clock.localDay(), sessionId), 1);
  } finally {
    fixture.close();
  }
});

test('台阶：3 小时不回时给一次台阶，之后 tick 全部 skip，用户发言后恢复', async () => {
  const fixture = makeFixture();
  try {
    const { store } = fixture;
    const sessionId = fixture.addSession();
    fixture.markUser(sessionId, 0);
    fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);
    fixture.addFact(sessionId, 'city', '杭州');
    fixture.advance(180 * MINUTE_MS);
    const llm = scriptedLlm();
    const schedule = fixture.makeSchedule(llm);

    const sent = await schedule.runTick(sessionId, 'manual');
    assert.equal(sent.decision, 'send');
    assert.equal(sent.guidance, 'step_down');
    assert.match(llm.calls[0].messages.map((message) => message.content).join('\n'), /台阶/);
    const dedup = store.sessions.findById(sessionId).hard_dedup_until;
    assert.ok(dedup);
    assert.equal(sent.nextTickAt, dedup);

    assert.equal((await schedule.runTick(sessionId, 'manual')).reason, 'silenced');
    assert.equal(store.messages.listForSession(sessionId, { limit: 10 }).filter((row) => row.role === 'char').length, 1);

    store.sessions.markUserMessage(sessionId, fixture.clock.iso());
    assert.equal(store.sessions.findById(sessionId).hard_dedup_until, null);
    fixture.addEvent(sessionId, '把洗好的衣服晾到了阳台。', 2);
    fixture.addEvent(sessionId, '下午把书架整理了一遍。', 3);
    fixture.addEvent(sessionId, '晚上给自己煮了粥。', 4);
    fixture.advance(180 * MINUTE_MS);

    const second = await schedule.runTick(sessionId, 'manual');
    assert.equal(second.decision, 'send');
    assert.equal(second.guidance, 'step_down');
    assert.equal(store.messages.listForSession(sessionId, { limit: 10 }).filter((row) => row.role === 'char').length, 2);
  } finally {
    fixture.close();
  }
});

test('喊累：高 tick 日先喊一次累，然后静默到次日', async () => {
  const fixture = makeFixture();
  try {
    const { store } = fixture;
    const sessionId = fixture.addSession();
    fixture.markUser(sessionId, 30);
    const llm = scriptedLlm();
    const schedule = fixture.makeSchedule(llm);

    for (let index = 0; index < 8; index += 1) {
      assert.equal((await schedule.runTick(sessionId, 'manual')).reason, 'no_anchor');
    }

    fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);
    fixture.addEvent(sessionId, '楼下新开了一家面馆，傍晚排了队。', 2);
    fixture.addEvent(sessionId, '晚上煮了一碗面。', 3);
    fixture.addFact(sessionId, 'city', '杭州');

    const sent = await schedule.runTick(sessionId, 'manual');
    assert.equal(sent.decision, 'send');
    assert.equal(sent.guidance, 'tired');
    assert.match(llm.calls[0].messages.map((message) => message.content).join('\n'), /有点累/);
    assert.ok(store.sessions.findById(sessionId).hard_dedup_until);

    assert.equal((await schedule.runTick(sessionId, 'manual')).reason, 'silenced');
  } finally {
    fixture.close();
  }
});

test('预算：全局 3 / 角色 2，超出当天不再发，次日额度重新计算', async () => {
  const fixture = makeFixture({ budget: { daily_global: 3, per_session: 2 }, schedule: { cooldown_min: 0, willingness_threshold: 0 } });
  try {
    const { store, clock, config } = fixture;
    const sessionA = fixture.addSession();
    const sessionB = fixture.addSession();
    fixture.markUser(sessionA, 0);
    fixture.markUser(sessionB, 0);
    fixture.advance(30 * MINUTE_MS);
    fixture.addEvent(sessionA, '今天把窗台擦了，屋里有点湿土味。', 1);
    fixture.addEvent(sessionA, '楼下新开了一家面馆，傍晚排了队。', 2);
    fixture.addEvent(sessionB, '晚上煮了一碗面。', 1);
    fixture.addEvent(sessionB, '在阳台坐了一会儿。', 2);
    const schedule = fixture.makeSchedule(scriptedLlm());

    assert.equal((await schedule.runTick(sessionA, 'manual')).decision, 'send');
    assert.equal((await schedule.runTick(sessionA, 'manual')).decision, 'send');
    assert.equal((await schedule.runTick(sessionA, 'manual')).reason, 'budget_session_full');
    assert.equal((await schedule.runTick(sessionB, 'manual')).decision, 'send');
    assert.equal((await schedule.runTick(sessionB, 'manual')).reason, 'budget_global_full');

    const day = clock.localDay();
    assert.equal(store.budget.usedOn(day, sessionA), 2);
    assert.equal(store.budget.usedOn(day, sessionB), 1);
    assert.equal(store.budget.globalUsedOn(day), 3);

    fixture.advance(24 * 60 * MINUTE_MS);
    fixture.markUser(sessionA, 0);
    fixture.addEvent(sessionA, '第二天把窗帘洗了。', 1);
    const nextDay = clock.localDay();
    assert.notEqual(nextDay, day);
    const sent = await schedule.runTick(sessionA, 'manual');
    assert.equal(sent.decision, 'send');
    assert.equal(store.budget.usedOn(nextDay, sessionA), 1);
    assert.equal(store.budget.globalUsedOn(nextDay), 1);
    assert.equal(config.budget.daily_global, 3);
  } finally {
    fixture.close();
  }
});

test('冷启动沉默：启动时已有 active 会话先不开口，用户发言后恢复', async () => {
  const fixture = makeFixture({ runtime: { cold_start_proactive: false } });
  try {
    const { store, config } = fixture;
    const sessionId = fixture.addSession();
    fixture.markUser(sessionId, 60);
    fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);
    fixture.addFact(sessionId, 'city', '杭州');
    config.schedule.cooldown_min = 0;
    config.schedule.willingness_threshold = 0;
    const schedule = fixture.makeSchedule(scriptedLlm());
    schedule.start();
    try {
      assert.equal(store.sessions.findById(sessionId).cold_start_silenced, 1);
      assert.equal((await schedule.runTick(sessionId, 'manual')).reason, 'cold_start');

      store.sessions.markUserMessage(sessionId, fixture.clock.iso());
      assert.equal(store.sessions.findById(sessionId).cold_start_silenced, 0);
      assert.equal((await schedule.runTick(sessionId, 'manual')).decision, 'send');
    } finally {
      schedule.stop();
    }
  } finally {
    fixture.close();
  }
});

test('留痕：ticks 默认最近 20 条，limit 夹在 1–20', async () => {
  const fixture = makeFixture();
  try {
    const sessionId = fixture.addSession();
    fixture.markUser(sessionId, 0);
    const schedule = fixture.makeSchedule(scriptedLlm());
    await schedule.runTick(sessionId, 'manual');
    await schedule.runTick(sessionId, 'manual');
    const rows = schedule.ticks(sessionId, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].trigger, 'manual');
    assert.equal(schedule.ticks(sessionId, 999).length, 2);
  } finally {
    fixture.close();
  }
});
