import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonBytes, makeV2Card } from '../helpers/card-fixtures.js';
import { startFakeLlm } from '../helpers/fake-llm.js';
import { startApp } from '../helpers/start-app.js';

let fake;

before(async () => {
  fake = await startFakeLlm();
});

after(async () => {
  await fake?.stop();
});

function configFor({ testHooks = true } = {}) {
  return {
    runtime: { test_hooks: testHooks, cold_start_proactive: true },
    schedule: { cooldown_min: 0, willingness_threshold: 0 },
    budget: { daily_global: 5, per_session: 1 },
    llm: {
      base_url: fake.baseUrl,
      api_key: 'test-key',
      chat_model: 'fake-proactive-ok',
      utility_model: 'fake-living-ok',
      chat_timeout_ms: 5000,
      utility_timeout_ms: 5000,
    },
  };
}

async function withApp(options, fn) {
  const app = await startApp({ config: configFor(options) });
  try {
    await fn(app);
  } finally {
    await app.stop();
  }
}

async function importCard(app, card) {
  const preview = await fetch(`${app.baseUrl}/api/cards/preview`, {
    method: 'POST',
    headers: { 'X-Filename': encodeURIComponent(`${card.data.name}.json`) },
    body: jsonBytes(card),
  });
  const previewBody = await preview.json();
  const commit = await fetch(`${app.baseUrl}/api/cards/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: previewBody.token, mode: 'new' }),
  });
  return commit.json();
}

async function startCard(app, cardId) {
  const response = await fetch(`${app.baseUrl}/api/cards/${cardId}/start`, { method: 'POST' });
  return response.json();
}

async function tick(app, sessionId, trigger = 'manual') {
  const response = await fetch(`${app.baseUrl}/api/test/tick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, trigger }),
  });
  return { status: response.status, body: await response.json() };
}

async function messages(app, sessionId) {
  const response = await fetch(`${app.baseUrl}/api/sessions/${sessionId}/messages`);
  return response.json();
}

async function ticks(app, sessionId, limit = 20) {
  const response = await fetch(`${app.baseUrl}/api/sessions/${sessionId}/debug/ticks?limit=${limit}`);
  return { status: response.status, body: await response.json() };
}

test('没有 SSE 连接也能 tick：主动消息落库、锚点非 none、留痕可读、预算满后不再发', async () => {
  await withApp({}, async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '调度甲' }));
    const started = await startCard(app, imported.card.id);
    const sessionId = started.session.id;

    const firstToday = await fetch(`${app.baseUrl}/api/sessions/${sessionId}/today`).then((res) => res.json());
    assert.equal(firstToday.events.length, 2);
    const secondToday = await fetch(`${app.baseUrl}/api/sessions/${sessionId}/today`).then((res) => res.json());
    assert.deepEqual(
      secondToday.events.map((event) => event.id),
      firstToday.events.map((event) => event.id),
    );

    const sent = await tick(app, sessionId, 'manual');
    assert.equal(sent.status, 200);
    assert.equal(sent.body.sessionId, sessionId);
    assert.equal(sent.body.decision, 'send');
    assert.equal(sent.body.reason, 'send');
    assert.equal(sent.body.trigger, 'manual');
    assert.ok(sent.body.willingness >= 0);
    assert.ok(sent.body.nextTickAt);

    const history = await messages(app, sessionId);
    assert.equal(history.messages.length, 1);
    const proactive = history.messages[0];
    assert.equal(proactive.role, 'char');
    assert.equal(proactive.is_proactive, 1);
    assert.notEqual(proactive.anchor_type, null);
    assert.notEqual(proactive.anchor_type, 'none');
    assert.equal(proactive.bubble_index, 0);

    const rows = await ticks(app, sessionId, 20);
    assert.equal(rows.status, 200);
    assert.equal(rows.body.ticks.length, 1);
    assert.equal(rows.body.ticks[0].decision, 'send');
    assert.equal(rows.body.ticks[0].decision_reason, 'send');
    assert.equal(rows.body.ticks[0].trigger, 'manual');

    const blocked = await tick(app, sessionId, 'manual');
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.decision, 'skip');
    assert.equal(blocked.body.reason, 'budget_session_full');

    const after = await messages(app, sessionId);
    assert.equal(after.messages.length, 1);
  });
});

test('测试 tick 的入参校验：未知会话 404、非法触发 400、limit 夹紧', async () => {
  await withApp({}, async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '调度乙' }));
    const started = await startCard(app, imported.card.id);
    const sessionId = started.session.id;

    const missing = await tick(app, 999999, 'manual');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'session_not_found');

    const invalid = await tick(app, sessionId, 'cron');
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'trigger_invalid');

    const rows = await ticks(app, sessionId, 999);
    assert.equal(rows.status, 200);
    assert.deepEqual(rows.body.ticks, []);
  });
});

test('默认关闭测试钩子：POST /api/test/tick 返回 404', async () => {
  await withApp({ testHooks: false }, async (app) => {
    const response = await fetch(`${app.baseUrl}/api/test/tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 1, trigger: 'manual' }),
    });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, 'not_found');
  });
});
