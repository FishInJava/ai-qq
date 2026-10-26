import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChat } from '../../src/chat/index.js';
import { createClock } from '../../src/clock/index.js';
import { createQuota } from '../../src/quota/index.js';
import { DEFAULT_CONFIG } from '../../src/runtime/config.js';
import { createSessionService } from '../../src/session/state.js';
import { openStore } from '../../src/store/index.js';
import { createStyle } from '../../src/style/index.js';

const silentLog = {
  info() {},
  warn() {},
  error() {},
};

function cardJson(name) {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: '住得近，偶尔一起吃饭。',
      personality: '安静，说话短。',
      scenario: '你和她住在同一栋楼。',
      mes_example: '你回来啦。',
    },
  });
}

function makeHarness({ nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime(), limit = 100 } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'companion-s2-session-'));
  let now = nowMs;
  const clock = createClock({ now: () => now });
  const store = openStore({ dataDir, clock });
  store.migrate();

  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.default_token_limit = limit;

  const events = [];
  const bus = {
    emit(topic, payload) {
      events.push({ topic, payload });
    },
  };
  const quota = createQuota({ store, clock, config });
  const session = createSessionService({ store, clock, config, quota, bus, log: silentLog });

  function addCharacter(name = '阿岚') {
    const characterId = store.characters.insert({
      name,
      cardJson: cardJson(name),
      extensionsJson: null,
      compat: 'v2',
      avatarPath: null,
      cardSourcePath: null,
      sourceHash: `hash-${name}-${Math.random()}`,
      importedAt: clock.iso(),
    });
    const sessionId = store.sessions.insert({
      characterId,
      state: 'unstarted',
      tokenLimit: limit,
      createdAt: clock.iso(),
    });
    return { characterId, sessionId };
  }

  return {
    dataDir,
    clock,
    store,
    config,
    bus,
    events,
    quota,
    session,
    addCharacter,
    advance(ms) {
      now += ms;
    },
    cleanup() {
      store.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test('状态机：开始 → 在忙 → 恢复带断层 → 耗尽 → 续额好转', () => {
  const harness = makeHarness({ limit: 100 });
  const { clock, store, quota, session, events } = harness;
  try {
    const { characterId, sessionId } = harness.addCharacter();

    const started = session.start(characterId);
    assert.equal(started.state, 'active');
    assert.equal(started.state_word, '醒着');
    assert.equal(events.filter((event) => event.topic === 'state').length, 1);

    assert.equal(session.transition(sessionId, 'pause').ok, true);
    assert.equal(session.view(sessionId).state, 'paused');
    harness.advance(5 * 60 * 60 * 1000);

    const resumed = session.transition(sessionId, 'resume');
    assert.equal(resumed.ok, true);
    assert.equal(resumed.session.state, 'active');
    const gap = store.sessions.findById(sessionId).pause_gap_hours;
    assert.ok(gap >= 4.99 && gap <= 5.01, `pause_gap_hours=${gap}`);
    session.clearPauseGap(sessionId);
    assert.equal(store.sessions.findById(sessionId).pause_gap_hours, null);

    const recorded = quota.record(sessionId, 'chat', 100);
    assert.equal(recorded.status, 'exhausted');
    assert.equal(recorded.exhausted, true);
    assert.equal(session.transition(sessionId, 'exhaust').ok, true);
    assert.equal(session.view(sessionId).state, 'dormant');
    assert.equal(session.canGenerate(sessionId), false);

    const illegal = session.transition(sessionId, 'pause');
    assert.equal(illegal.ok, false);
    assert.equal(store.sessions.findById(sessionId).state, 'dormant');

    const refilled = session.refill(sessionId, 50);
    assert.equal(refilled.session.state, 'active');
    assert.equal(refilled.session.token_limit, 150);
    assert.equal(refilled.session.token_used, 100);
    assert.equal(refilled.quota.status, 'ok');
    const ledger = store.tokenLedger.listForSession(sessionId);
    assert.equal(ledger[0].kind, 'refill');
    assert.equal(ledger[0].amount, 50);
    assert.equal(session.isRecovered(sessionId), true);

    store.messages.insert({
      sessionId,
      role: 'char',
      content: '嗯。',
      createdAt: clock.iso(),
    });
    assert.equal(session.isRecovered(sessionId), false);

    const shrunk = session.setTokenLimit(sessionId, 50);
    assert.equal(shrunk.state, 'dormant');
    assert.equal(store.sessions.findById(sessionId).token_limit, 50);
  } finally {
    harness.cleanup();
  }
});

test('pauseAll 只暂停醒着的会话；已耗尽的直接转不方便', () => {
  const harness = makeHarness({ limit: 10 });
  const { store, session, quota } = harness;
  try {
    const first = harness.addCharacter('阿岚');
    const second = harness.addCharacter('阿枝');
    const third = harness.addCharacter('阿禾');
    session.start(first.characterId);
    session.start(second.characterId);
    session.start(third.characterId);

    quota.record(second.sessionId, 'chat', 10);
    session.transition(second.sessionId, 'exhaust');

    const paused = session.pauseAll();
    assert.equal(paused, 2);
    assert.equal(store.sessions.findById(first.sessionId).state, 'paused');
    assert.equal(store.sessions.findById(second.sessionId).state, 'dormant');
    assert.equal(store.sessions.findById(third.sessionId).state, 'paused');
  } finally {
    harness.cleanup();
  }
});

test('view / canGenerate 把历史遗留的耗尽会话懒迁移到 dormant', () => {
  const harness = makeHarness({ limit: 10 });
  const { store, session } = harness;
  try {
    const { characterId, sessionId } = harness.addCharacter();
    session.start(characterId);
    store.sessions.addTokens(sessionId, 10);
    assert.equal(store.sessions.findById(sessionId).state, 'active');

    const view = session.view(sessionId);
    assert.equal(view.state, 'dormant');
    assert.equal(store.sessions.findById(sessionId).state, 'dormant');

    const another = harness.addCharacter('阿枝');
    session.start(another.characterId);
    store.sessions.addTokens(another.sessionId, 10);
    assert.equal(session.canGenerate(another.sessionId), false);
    assert.equal(store.sessions.findById(another.sessionId).state, 'dormant');
  } finally {
    harness.cleanup();
  }
});

test('用量按本地日聚合：chat / proactive / refill 分开，refill 不计入用量', () => {
  const harness = makeHarness({ limit: 1000 });
  const { clock, quota } = harness;
  try {
    const { characterId, sessionId } = harness.addCharacter();
    harness.session.start(characterId);

    const dayOne = clock.localDay();
    quota.record(sessionId, 'chat', 10);
    harness.advance(24 * 60 * 60 * 1000);
    const dayTwo = clock.localDay();
    quota.record(sessionId, 'chat', 20);
    quota.record(sessionId, 'proactive', 5);
    quota.raiseLimit(sessionId, 50);

    const usage = quota.usage({ from: dayOne, to: dayTwo });
    assert.equal(usage.from, dayOne);
    assert.equal(usage.to, dayTwo);
    assert.equal(usage.daily.length, 2);
    assert.equal(usage.daily[0].chat, 10);
    assert.equal(usage.daily[0].total, 10);
    assert.equal(usage.daily[1].chat, 20);
    assert.equal(usage.daily[1].proactive, 5);
    assert.equal(usage.daily[1].refill, 50);
    assert.equal(usage.daily[1].total, 25);
    assert.deepEqual(usage.totals, { chat: 30, proactive: 5, refill: 50, total: 35 });
    assert.equal(usage.entries.length, 4);
    assert.equal(usage.entries.at(-1).kind, 'refill');

    const [row] = usage.sessions;
    assert.equal(row.session_id, sessionId);
    assert.equal(row.used, 35);
    assert.equal(row.limit, 1050);
    assert.equal(row.exhausted, false);

    assert.throws(() => quota.usage({ from: '2026-02-30' }), (err) => err.status === 400);
    assert.throws(
      () => quota.usage({ from: dayTwo, to: dayOne }),
      (err) => err.status === 400,
    );
  } finally {
    harness.cleanup();
  }
});

test('T9 生成提示含时间断层；续额后带好转，下一句自动消失', () => {
  const harness = makeHarness({ limit: 1000 });
  const { clock, store, config, quota, session } = harness;
  try {
    const { characterId, sessionId } = harness.addCharacter();
    session.start(characterId);

    store.messages.insert({
      sessionId,
      role: 'user',
      content: '我出门了。',
      createdAt: clock.iso(),
    });
    store.sessions.setPauseGap(sessionId, 5);

    const style = createStyle();
    const chat = createChat({
      store,
      clock,
      config,
      llm: {},
      style,
      quota,
      session,
      bus: { emit() {} },
      log: silentLog,
    });

    const context = chat.buildContext(sessionId, 'chat');
    const prompt = context.messages.map((message) => message.content).join('\n');
    assert.match(prompt, /大约 5 小时/);
    assert.doesNotMatch(prompt, /pause_gap_hours/);

    quota.raiseLimit(sessionId, 100);
    const recovered = chat.buildContext(sessionId, 'chat');
    const recoveredPrompt = recovered.messages.map((message) => message.content).join('\n');
    assert.match(recoveredPrompt, /好转/);

    store.messages.insert({
      sessionId,
      role: 'char',
      content: '回来啦。',
      createdAt: clock.iso(),
    });
    const settled = chat.buildContext(sessionId, 'chat');
    assert.doesNotMatch(
      settled.messages.map((message) => message.content).join('\n'),
      /好转/,
    );
  } finally {
    harness.cleanup();
  }
});
