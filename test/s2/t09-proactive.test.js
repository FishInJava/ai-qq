import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClock } from '../../src/clock/index.js';
import { createLlm } from '../../src/llm/index.js';
import { createProactive } from '../../src/proactive/index.js';
import { createQuota } from '../../src/quota/index.js';
import { createStyle } from '../../src/style/index.js';
import { createBus } from '../../src/runtime/bus.js';
import { openStore } from '../../src/store/index.js';
import { startFakeLlm } from '../helpers/fake-llm.js';

const FIXED_MS = Date.parse('2026-10-01T02:00:00.000Z');

function makeConfig(overrides = {}) {
  return {
    llm: {
      base_url: '',
      api_key: '',
      chat_model: 'fake-proactive-ok',
      utility_model: '',
      chat_timeout_ms: 5000,
      utility_timeout_ms: 5000,
      context_budget: 8000,
      proactive_context_budget: 2000,
      ...(overrides.llm ?? {}),
    },
    budget: { daily_global: 5, per_session: 2, ...(overrides.budget ?? {}) },
    quota: { default_token_limit: 500000, warn_ratio: 0.7, ...(overrides.quota ?? {}) },
  };
}

function makeFixture(configOverrides = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'companion-proactive-'));
  const clock = createClock({ now: () => FIXED_MS });
  const store = openStore({ dataDir, clock });
  store.migrate();
  const config = makeConfig(configOverrides);

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

  function addEvent(sessionId, content, ordinal) {
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

  function addMessage(sessionId, role, content) {
    return store.messages.insert({
      sessionId,
      role,
      content,
      createdAt: clock.iso(),
    });
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
    addSession,
    addEvent,
    addFact,
    addMessage,
    makeProactive(llm) {
      return createProactive({
        store,
        clock,
        config,
        llm,
        style,
        quota,
        bus,
        log,
      });
    },
    close() {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function scriptedLlm(script) {
  const calls = [];
  return {
    calls,
    async *chatStream(options) {
      calls.push(options);
      const result = script(calls.length, options);
      if (result instanceof Error) {
        throw result;
      }
      const text = typeof result === 'string' ? result : result.text;
      const usage = typeof result === 'string' ? { total_tokens: 30 } : result.usage;
      yield { delta: text };
      yield { usage };
      yield { done: true };
    },
  };
}

function anchorResponse(type, id, bubble) {
  return JSON.stringify({ bubbles: [bubble], anchor: { type, id } });
}

test('锚点集合：今日未用事件在前、pending facts 在后，截断 5 条', () => {
  const fixture = makeFixture();
  try {
    const { store, clock } = fixture;
    const sessionId = fixture.addSession();
    const event1 = fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);
    const event2 = fixture.addEvent(sessionId, '楼下新开了一家面馆，傍晚排了队。', 2);
    const event3 = fixture.addEvent(sessionId, '晚上煮了一碗面。', 3);
    const usedMessage = fixture.addMessage(sessionId, 'char', '今天开了一整天的会。');
    store.lifeEvents.markUsed(event2, usedMessage);

    const fact1 = fixture.addFact(sessionId, 'city', '杭州');
    const fact2 = fixture.addFact(sessionId, 'job', '产品经理');
    const fact3 = fixture.addFact(sessionId, 'interview', '周三有一场面试');
    const fact4 = fixture.addFact(sessionId, 'mood', '最近有点累');
    const fact5 = fixture.addFact(sessionId, 'drink', '喜欢喝冰美式');
    const expired = fixture.addFact(sessionId, 'old_city', '上海');
    store.facts.close(expired, clock.iso());

    const proactive = fixture.makeProactive(scriptedLlm(() => '{}'));
    const anchors = proactive.buildAnchors(sessionId);

    assert.equal(anchors.length, 5);
    assert.deepEqual(anchors.map((anchor) => anchor.type), ['event', 'event', 'fact', 'fact', 'fact']);
    assert.deepEqual(anchors.slice(0, 2).map((anchor) => anchor.id), [event1, event3]);
    assert.deepEqual(anchors.slice(2).map((anchor) => anchor.id), [fact5, fact4, fact3]);
    assert.ok(!anchors.some((anchor) => anchor.id === event2));
    assert.ok(!anchors.some((anchor) => anchor.id === expired));
    assert.ok(!anchors.some(
      (anchor) => anchor.type === 'fact' && (anchor.id === fact1 || anchor.id === fact2),
    ));
  } finally {
    fixture.close();
  }
});

test('主动上下文：六项分配、先丢最旧原文再压 facts、总量不超对话预算 1/3', () => {
  const fixture = makeFixture();
  try {
    const { store, clock, config } = fixture;
    const sessionId = fixture.addSession();
    const longEvent = `${'今天'.repeat(30)}。`;
    fixture.addEvent(sessionId, longEvent, 1);
    fixture.addEvent(sessionId, `${'窗台'.repeat(30)}。`, 2);
    for (let index = 0; index < 5; index += 1) {
      fixture.addFact(sessionId, `key${index}`, '杭州'.repeat(50));
    }

    const messageIds = [];
    for (let index = 0; index < 6; index += 1) {
      messageIds.push(fixture.addMessage(
        sessionId,
        index % 2 === 0 ? 'user' : 'char',
        `第${index + 1}条：${'最近的消息'.repeat(100)}`,
      ));
    }
    for (let index = 0; index < 3; index += 1) {
      store.summaries.insert({
        sessionId,
        fromMsgId: messageIds[index * 2],
        toMsgId: messageIds[index * 2 + 1],
        content: `摘要${index + 1}：${'以前的摘要'.repeat(60)}`,
        createdAt: clock.iso(),
      });
    }

    const proactive = fixture.makeProactive(scriptedLlm(() => '{}'));
    const anchors = proactive.buildAnchors(sessionId);

    const assertPersona = (context) => {
      assert.equal(context.messages[0].role, 'system');
      assert.match(context.messages[0].content, /主动开口的规矩/);
    };

    config.llm.context_budget = 3900;
    config.llm.proactive_context_budget = 2000;
    const medium = proactive.buildContext(sessionId, anchors);
    assert.equal(medium.budget, 1300);
    assert.ok(medium.tokens <= 1300);
    assertPersona(medium);
    const mediumText = medium.messages.map((message) => message.content).join('\n');
    assert.match(mediumText, /第6条/);
    assert.doesNotMatch(mediumText, /第1条/);
    assert.match(mediumText, /\[fact:\d+\]/);
    assert.match(mediumText, /【以前的摘要】/);

    config.llm.context_budget = 2100;
    const tight = proactive.buildContext(sessionId, anchors);
    assert.equal(tight.budget, 700);
    assert.ok(tight.tokens <= 700);
    assertPersona(tight);
    const tightText = tight.messages.map((message) => message.content).join('\n');
    assert.doesNotMatch(tightText, /第6条/);
    assert.doesNotMatch(tightText, /\[fact:\d+\]/);
    assert.match(tightText, /【她今天】/);
    assert.match(tightText, /【以前的摘要】/);

    config.llm.context_budget = 300;
    const tiny = proactive.buildContext(sessionId, anchors);
    assert.equal(tiny.budget, 100);
    assert.ok(tiny.tokens <= 100);
    assert.equal(tiny.messages.length, 1);
    assert.equal(tiny.messages[0].role, 'system');
  } finally {
    fixture.close();
  }
});

test('锚点复核：id 不在集合、type 不对、正文不含关键片段都不通过', () => {
  const fixture = makeFixture();
  try {
    const sessionId = fixture.addSession();
    const eventId = fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);
    const factId = fixture.addFact(sessionId, 'city', '杭州');
    const factId2 = fixture.addFact(sessionId, 'job', '产品经理');
    const proactive = fixture.makeProactive(scriptedLlm(() => '{}'));
    const anchors = proactive.buildAnchors(sessionId);

    assert.deepEqual(
      proactive.validate({ bubbles: ['今天把窗台擦了。'], anchor: { type: 'event', id: eventId } }, anchors),
      { ok: true, reason: null, anchor: { type: 'event', id: eventId } },
    );

    const missing = proactive.validate(
      { bubbles: ['今天把窗台擦了。'], anchor: { type: 'event', id: 999999 } },
      anchors,
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'anchor_fail');
    assert.equal(missing.detail, 'anchor_not_in_set');

    const wrongType = proactive.validate(
      { bubbles: ['今天把窗台擦了。'], anchor: { type: 'event', id: factId2 } },
      anchors,
    );
    assert.equal(wrongType.ok, false);
    assert.equal(wrongType.detail, 'anchor_not_in_set');

    const mismatch = proactive.validate(
      { bubbles: ['在干嘛呢。'], anchor: { type: 'event', id: eventId } },
      anchors,
    );
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.detail, 'anchor_text_mismatch');

    assert.equal(
      proactive.validate(
        { bubbles: ['之前你说过杭州，我一直记着。'], anchor: { type: 'fact', id: factId } },
        anchors,
      ).ok,
      true,
    );
  } finally {
    fixture.close();
  }
});

test('她只提到锚点里几个字的具体说法时消息发得出来，泛泛问候仍然被丢弃', () => {
  const fixture = makeFixture();
  try {
    const sessionId = fixture.addSession();
    const tattoo = fixture.addEvent(sessionId, 'Sakura今天在“暗之花”纹身店给客人纹了日式恶鬼图案', 1);
    const english = fixture.addEvent(
      sessionId,
      'I pulled a quick smuggling run for eddies, bitching the whole way through back a',
      2,
    );

    const proactive = fixture.makeProactive(scriptedLlm(() => '{}'));
    const anchors = proactive.buildAnchors(sessionId);

    assert.equal(
      proactive.validate(
        { bubbles: ['今天在暗之花给人纹了只恶鬼，手有点酸。'], anchor: { type: 'event', id: tattoo } },
        anchors,
      ).ok,
      true,
    );
    assert.equal(
      proactive.validate(
        { bubbles: ['eddies 那趟活儿结得比想的快。'], anchor: { type: 'event', id: english } },
        anchors,
      ).ok,
      true,
    );

    const generic = proactive.validate(
      { bubbles: ['从那边 through 过来一路都挺顺。'], anchor: { type: 'event', id: english } },
      anchors,
    );
    assert.equal(generic.ok, false);
    assert.equal(generic.detail, 'anchor_text_mismatch');

    const smallTalk = proactive.validate(
      { bubbles: ['在干嘛呢。'], anchor: { type: 'event', id: tattoo } },
      anchors,
    );
    assert.equal(smallTalk.ok, false);
    assert.equal(smallTalk.detail, 'anchor_text_mismatch');

    const context = proactive.buildContext(sessionId, anchors);
    assert.match(context.messages[0].content, /原样抄/);
  } finally {
    fixture.close();
  }
});

test('事件锚点：生成通过校验，提交写消息、留痕、标记已用并扣一次预算', async () => {
  const fixture = makeFixture();
  try {
    const { store, clock } = fixture;
    const sessionId = fixture.addSession();
    const eventId = fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);
    const llm = scriptedLlm(() => anchorResponse('event', eventId, '今天把窗台擦了。'));
    const proactive = fixture.makeProactive(llm);

    const generated = await proactive.generate(sessionId);
    assert.equal(generated.ok, true);
    assert.equal(generated.anchor.type, 'event');
    assert.equal(generated.anchor.id, eventId);
    assert.deepEqual(generated.bubbles, ['今天把窗台擦了。']);
    assert.equal(generated.tokens, 30);
    assert.equal(generated.estimated, false);
    assert.equal(generated.attempts, 1);
    assert.equal(llm.calls[0].jsonMode, true);
    assert.equal(llm.calls[0].maxTokens, 300);
    assert.match(llm.calls[0].messages.map((message) => message.content).join('\n'), new RegExp(`\\[event:${eventId}\\]`));

    const committed = proactive.commit(sessionId, generated, generated.anchor);
    assert.equal(committed.ok, true);

    const rows = store.messages.listForSession(sessionId, { limit: 10 }).reverse();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, 'char');
    assert.equal(rows[0].is_proactive, 1);
    assert.equal(rows[0].anchor_type, 'event');
    assert.equal(rows[0].anchor_id, eventId);
    assert.equal(rows[0].bubble_index, 0);

    const logRows = store.proactiveLog.listRecent(sessionId, 5);
    assert.equal(logRows.length, 1);
    assert.equal(logRows[0].content, '今天把窗台擦了。');
    assert.equal(logRows[0].fingerprint, '今天把窗台擦了。'.slice(0, 8));

    const day = clock.localDay();
    assert.equal(store.lifeEvents.listUnusedForDay(sessionId, day).length, 0);
    assert.equal(store.lifeEvents.listForDay(sessionId, day)[0].used_by_msg_id, rows[0].id);
    assert.equal(store.budget.usedOn(day, sessionId), 1);
    assert.equal(store.sessions.findById(sessionId).last_proactive_at, committed.createdAt);
    assert.equal(store.sessions.findById(sessionId).consecutive_ignored, 0);

    const ledger = store.tokenLedger.listForSession(sessionId);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].kind, 'proactive');
    assert.equal(ledger[0].amount, 30);
    assert.equal(ledger[0].ref_type, 'message');
    assert.equal(ledger[0].ref_id, rows[0].id);

    assert.equal(proactive.buildAnchors(sessionId).length, 0);
    assert.equal(fixture.events.filter((event) => event.topic === 'message').length, 1);
    assert.equal(fixture.events.find((event) => event.topic === 'message').payload.message.is_proactive, 1);
  } finally {
    fixture.close();
  }
});

test('事实锚点：提交后 pending 转 done，不再进候选池', async () => {
  const fixture = makeFixture();
  try {
    const { store } = fixture;
    const sessionId = fixture.addSession();
    const factId = fixture.addFact(sessionId, 'city', '杭州');
    const proactive = fixture.makeProactive(
      scriptedLlm(() => anchorResponse('fact', factId, '之前你说过杭州，我一直记着。')),
    );

    const generated = await proactive.generate(sessionId);
    assert.equal(generated.ok, true);
    assert.equal(generated.anchor.type, 'fact');
    assert.equal(generated.anchor.id, factId);

    const committed = proactive.commit(sessionId, generated, generated.anchor);
    assert.equal(committed.ok, true);
    assert.equal(store.facts.findById(factId).status, 'done');
    assert.equal(proactive.buildAnchors(sessionId).length, 0);
  } finally {
    fixture.close();
  }
});

test('锚点失败、坏 JSON、模型报错都不扣预算、不写消息', async () => {
  const fixture = makeFixture();
  try {
    const { store } = fixture;
    const sessionId = fixture.addSession();
    const eventId = fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);

    const wrongAnchor = fixture.makeProactive(
      scriptedLlm(() => anchorResponse('event', 999999, '今天把窗台擦了。')),
    );
    assert.deepEqual(
      await wrongAnchor.generate(sessionId),
      { ok: false, reason: 'anchor_fail' },
    );

    const badJson = fixture.makeProactive(scriptedLlm(() => 'not json'));
    assert.deepEqual(
      await badJson.generate(sessionId),
      { ok: false, reason: 'llm_bad_response' },
    );

    const llmError = fixture.makeProactive(scriptedLlm(() => Object.assign(new Error('down'), { code: 'llm_unavailable' })));
    assert.deepEqual(
      await llmError.generate(sessionId),
      { ok: false, reason: 'llm_error' },
    );

    assert.equal(store.budget.usedOn(fixture.clock.localDay(), sessionId), 0);
    assert.equal(store.messages.listForSession(sessionId, { limit: 10 }).length, 0);
    assert.equal(store.proactiveLog.listRecent(sessionId, 10).length, 0);
    assert.ok(fixture.logs.some((entry) => entry.name === 'proactive_drop' && entry.fields.reason === 'anchor_fail'));
    assert.ok(fixture.logs.some((entry) => entry.name === 'proactive_drop' && entry.fields.reason === 'llm_error'));
    assert.equal(store.lifeEvents.listUnusedForDay(sessionId, fixture.clock.localDay())[0].id, eventId);
  } finally {
    fixture.close();
  }
});

test('超长先截到第一句；仍超与系统腔各重生成一次，第二次仍不行就丢弃', async () => {
  const fixture = makeFixture();
  try {
    const sessionId = fixture.addSession();
    const eventId = fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);
    const longText = '今天下午我把阳台上的那盆薄荷搬回屋里因为外面起风了叶子被吹得一直抖我看着有点心疼就想着还是先搬进来等风小一点再放出去现在屋里有一点湿土的味道';
    const shortFirst = `今天把窗台擦了。${'后面还有一点别的事情要说但是不用说得太长我就在阳台坐了一会儿风也小了天也黑了屋里有点凉我就把窗户关上了然后去煮了碗面'}`;

    const truncated = fixture.makeProactive(scriptedLlm(() => anchorResponse('event', eventId, shortFirst)));
    const truncatedResult = await truncated.generate(sessionId);
    assert.equal(truncatedResult.ok, true);
    assert.equal(truncatedResult.attempts, 1);
    assert.deepEqual(truncatedResult.bubbles, ['今天把窗台擦了。']);

    const regenerated = fixture.makeProactive(scriptedLlm((call) => (
      call === 1 ? anchorResponse('event', eventId, longText) : anchorResponse('event', eventId, '今天把窗台擦了。')
    )));
    const regeneratedResult = await regenerated.generate(sessionId);
    assert.equal(regeneratedResult.ok, true);
    assert.equal(regeneratedResult.attempts, 2);
    assert.ok(regeneratedResult.bubbles.join('').length <= 60);

    const tooLong = fixture.makeProactive(scriptedLlm(() => anchorResponse('event', eventId, longText)));
    assert.deepEqual(await tooLong.generate(sessionId), { ok: false, reason: 'too_long' });

    const styled = fixture.makeProactive(scriptedLlm((call) => (
      call === 1
        ? anchorResponse('event', eventId, '根据当前额度，我作为 AI 无法继续回应。')
        : anchorResponse('event', eventId, '今天把窗台擦了。')
    )));
    const styledResult = await styled.generate(sessionId);
    assert.equal(styledResult.ok, true);
    assert.equal(styledResult.attempts, 2);

    const blocked = fixture.makeProactive(
      scriptedLlm(() => anchorResponse('event', eventId, '根据当前额度，我作为 AI 无法继续回应。')),
    );
    assert.deepEqual(await blocked.generate(sessionId), { ok: false, reason: 'style_blocked' });
  } finally {
    fixture.close();
  }
});

test('预算闸门：全局 5 / 单角色 2；生成后被抢满则提交丢弃并记一次 ignored', async () => {
  const fixture = makeFixture();
  try {
    const { store, clock } = fixture;
    const sessionId = fixture.addSession();
    const eventId = fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);
    const day = clock.localDay();
    const proactive = fixture.makeProactive(
      scriptedLlm(() => anchorResponse('event', eventId, '今天把窗台擦了。')),
    );

    assert.equal(proactive.gate(sessionId).ok, true);
    assert.equal(proactive.gate(sessionId).remaining, 2);

    store.budget.increment(day, sessionId, 2);
    assert.equal(proactive.gate(sessionId).reason, 'budget_session_full');
    const generatedWhileFull = await proactive.generate(sessionId);
    assert.deepEqual(generatedWhileFull, { ok: false, reason: 'budget_session_full' });

    const otherA = fixture.addSession();
    const otherB = fixture.addSession();
    const otherC = fixture.addSession();
    store.budget.increment(day, otherA, 2);
    store.budget.increment(day, otherB, 2);
    store.budget.increment(day, otherC, 1);
    assert.equal(proactive.gate(sessionId).reason, 'budget_global_full');
  } finally {
    fixture.close();
  }
});

test('提交前复检：用户抢话、会话转暂停、预算被抢满都不落消息', async () => {
  const fixture = makeFixture();
  try {
    const { store, clock } = fixture;
    const sessionId = fixture.addSession();
    const eventId = fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);
    const llm = scriptedLlm(() => anchorResponse('event', eventId, '今天把窗台擦了。'));
    const proactive = fixture.makeProactive(llm);

    const raced = await proactive.generate(sessionId);
    assert.equal(raced.ok, true);
    store.sessions.markUserMessage(sessionId, clock.iso());
    assert.deepEqual(proactive.commit(sessionId, raced, raced.anchor), { ok: false, reason: 'race' });
    assert.equal(store.messages.listForSession(sessionId, { limit: 10 }).length, 0);
    assert.equal(store.budget.usedOn(clock.localDay(), sessionId), 0);
    assert.equal(store.sessions.findById(sessionId).consecutive_ignored, 0);

    const paused = await proactive.generate(sessionId);
    assert.equal(paused.ok, true);
    store.sessions.setState(sessionId, 'paused');
    assert.deepEqual(proactive.commit(sessionId, paused, paused.anchor), { ok: false, reason: 'state_not_active' });
    assert.equal(store.messages.listForSession(sessionId, { limit: 10 }).length, 0);

    store.sessions.setState(sessionId, 'active');
    const budgetRaced = await proactive.generate(sessionId);
    assert.equal(budgetRaced.ok, true);
    store.budget.increment(clock.localDay(), sessionId, 2);
    assert.deepEqual(
      proactive.commit(sessionId, budgetRaced, budgetRaced.anchor),
      { ok: false, reason: 'budget_session_full' },
    );
    assert.equal(store.sessions.findById(sessionId).consecutive_ignored, 1);
    assert.equal(store.messages.listForSession(sessionId, { limit: 10 }).length, 0);
    assert.equal(store.tokenLedger.listForSession(sessionId).length, 0);
    assert.equal(store.lifeEvents.listUnusedForDay(sessionId, clock.localDay())[0].id, eventId);
  } finally {
    fixture.close();
  }
});

test('真实 llm 客户端 + 假服务：proactive-ok 回读锚点，请求带 json_mode 与 stream', async () => {
  const fake = await startFakeLlm();
  const fixture = makeFixture({
    llm: {
      base_url: fake.baseUrl,
      api_key: 'test-key',
      chat_model: 'fake-proactive-ok',
    },
  });
  try {
    const sessionId = fixture.addSession();
    const eventId = fixture.addEvent(sessionId, '今天把窗台擦了，屋里有点湿土味。', 1);
    const llm = createLlm({ config: fixture.config, clock: fixture.clock, log: { warn() {} } });
    const proactive = fixture.makeProactive(llm);

    const generated = await proactive.generate(sessionId);
    assert.equal(generated.ok, true);
    assert.equal(generated.anchor.type, 'event');
    assert.equal(generated.anchor.id, eventId);

    const last = await fake.lastRequest();
    assert.equal(last.stream, true);
    assert.equal(last.json_mode, true);
    assert.equal(last.model, 'fake-proactive-ok');

    const committed = proactive.commit(sessionId, generated, generated.anchor);
    assert.equal(committed.ok, true);
    assert.equal(fixture.store.messages.listForSession(sessionId, { limit: 10 })[0].is_proactive, 1);
  } finally {
    fixture.close();
    await fake.stop();
  }
});
