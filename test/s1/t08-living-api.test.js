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

async function today(app, sessionId) {
  const response = await fetch(`${app.baseUrl}/api/sessions/${sessionId}/today`);
  return { status: response.status, body: await response.json() };
}

test('打开“她的今天”会补齐 2–3 条当日事件，重复请求不重复', async () => {
  await withApp(async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '生活甲' }));
    const started = await startCard(app, imported.card.id);

    const first = await today(app, started.session.id);
    assert.equal(first.status, 200);
    assert.match(first.body.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(first.body.events.length, 2);
    assert.deepEqual(first.body.events.map((event) => event.ordinal), [1, 2]);
    assert.equal(first.body.events[0].content, '今天把窗台擦了，屋里有点湿土味。');
    assert.equal(first.body.events[0].used_by_msg_id, null);
    assert.ok(Array.isArray(first.body.feeds));

    const second = await today(app, started.session.id);
    assert.deepEqual(
      second.body.events.map((event) => event.id),
      first.body.events.map((event) => event.id),
    );
  });
});

test('未知会话的“她的今天”返回 404', async () => {
  await withApp(async (app) => {
    const missing = await today(app, 999999);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'session_not_found');
  });
});
