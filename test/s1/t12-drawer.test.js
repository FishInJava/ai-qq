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

async function withApp(fn) {
  const app = await startApp({
    config: {
      runtime: { test_hooks: true },
      llm: {
        base_url: fake.baseUrl,
        api_key: 'test-key',
        chat_model: 'fake-ok',
        utility_model: 'fake-living-ok',
        chat_timeout_ms: 5000,
        utility_timeout_ms: 5000,
      },
    },
  });
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

test('页面上的细节抽屉只有四个只读页签，没有原型控制', async () => {
  await withApp(async (app) => {
    const page = await fetch(`${app.baseUrl}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /id="drawerDialog"/);
    assert.match(html, /id="tab-sched"[^>]*>调度</);
    assert.match(html, /id="tab-memory"[^>]*>记忆</);
    assert.match(html, /id="tab-today"[^>]*>她的今天</);
    assert.match(html, /id="tab-usage"[^>]*>用量</);
    assert.doesNotMatch(html, /原型/);
    assert.doesNotMatch(html, /panel-proto/);

    const script = await (await fetch(`${app.baseUrl}/app.js`)).text();
    assert.match(script, /debug\/ticks\?limit=20/);
    assert.match(script, /\/memory`/);
    assert.match(script, /\/today`/);
    assert.match(script, /Promise\.allSettled/);
  });
});

test('抽屉四个只读接口在空会话上返回可渲染字段', async () => {
  await withApp(async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '抽屉甲' }));
    const started = await startCard(app, imported.card.id);
    const id = started.session.id;

    const paused = await fetch(`${app.baseUrl}/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    assert.equal(paused.status, 200);

    const tick = await fetch(`${app.baseUrl}/api/test/tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: id, trigger: 'manual' }),
    });
    assert.equal(tick.status, 200);

    const [ticksResponse, memoryResponse, todayResponse, usageResponse] = await Promise.all([
      fetch(`${app.baseUrl}/api/sessions/${id}/debug/ticks?limit=20`),
      fetch(`${app.baseUrl}/api/sessions/${id}/memory`),
      fetch(`${app.baseUrl}/api/sessions/${id}/today`),
      fetch(`${app.baseUrl}/api/usage`),
    ]);
    assert.equal(ticksResponse.status, 200);
    assert.equal(memoryResponse.status, 200);
    assert.equal(todayResponse.status, 200);
    assert.equal(usageResponse.status, 200);

    const ticks = await ticksResponse.json();
    const memory = await memoryResponse.json();
    const today = await todayResponse.json();
    const usage = await usageResponse.json();

    assert.ok(Array.isArray(ticks.ticks));
    assert.ok(ticks.ticks.length >= 1);
    for (const key of ['created_at', 'trigger', 'decision', 'decision_reason', 'willingness']) {
      assert.ok(Object.hasOwn(ticks.ticks[0], key), key);
    }
    assert.equal(ticks.ticks[0].decision_reason, 'state_not_active');

    assert.ok(Array.isArray(memory.facts));
    assert.ok(Array.isArray(memory.summaries));
    assert.match(today.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(today.events));
    assert.ok(today.events.length >= 2);
    for (const key of ['content', 'event_date', 'used_by_msg_id']) {
      assert.ok(Object.hasOwn(today.events[0], key), key);
    }
    assert.ok(Array.isArray(today.feeds));

    assert.ok(Array.isArray(usage.sessions));
    const row = usage.sessions.find((item) => item.session_id === id);
    assert.ok(row);
    for (const key of ['used', 'limit', 'ratio', 'warn', 'exhausted', 'status']) {
      assert.ok(Object.hasOwn(row, key), key);
    }
    assert.ok(Array.isArray(usage.daily));
    assert.ok(Array.isArray(usage.entries));
  });
});
