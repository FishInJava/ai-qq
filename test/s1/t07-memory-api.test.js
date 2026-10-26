import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonBytes, makeV2Card } from '../helpers/card-fixtures.js';
import { startFakeLlm } from '../helpers/fake-llm.js';
import { readSseEvents } from '../helpers/sse.js';
import { startApp } from '../helpers/start-app.js';

let fake;

before(async () => {
  fake = await startFakeLlm();
});

after(async () => {
  await fake?.stop();
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeout = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await delay(50);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
}

async function withApp(fn) {
  const app = await startApp({
    config: {
      llm: {
        base_url: fake.baseUrl,
        api_key: 'test-key',
        chat_model: 'fake-ok',
        utility_model: 'fake-memory-ok',
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

async function send(app, sessionId, text) {
  const response = await fetch(`${app.baseUrl}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  assert.equal(response.status, 200);
  return readSseEvents(response, {
    until: (event) => event.event === 'done' || event.event === 'error',
  });
}

async function memoryOf(app, sessionId) {
  const response = await fetch(`${app.baseUrl}/api/sessions/${sessionId}/memory`);
  return { status: response.status, body: await response.json() };
}

test('对话结束后异步落事实，记忆接口可读可删', async () => {
  await withApp(async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '记忆甲' }));
    const started = await startCard(app, imported.card.id);
    const sessionId = started.session.id;

    const events = await send(app, sessionId, '我住在杭州。');
    assert.equal(events.at(-1).event, 'done');

    const withFact = await waitFor(async () => {
      const page = await memoryOf(app, sessionId);
      return page.body.facts.length > 0 ? page : null;
    }, { label: 'fact extracted' });

    const fact = withFact.body.facts[0];
    assert.equal(fact.subject, 'user');
    assert.equal(fact.key, 'city');
    assert.equal(fact.value, '杭州');
    assert.equal(fact.status, 'pending');
    assert.equal(fact.valid_to, null);
    assert.ok(fact.source_msg_id > 0);

    const removed = await fetch(`${app.baseUrl}/api/memory/facts/${fact.id}`, {
      method: 'DELETE',
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true });

    const afterDelete = await memoryOf(app, sessionId);
    assert.equal(afterDelete.body.facts.length, 0);

    const missing = await fetch(`${app.baseUrl}/api/memory/facts/${fact.id}`, {
      method: 'DELETE',
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'fact_not_found');
  });
});

test('第 20 个用户轮次后生成摘要，记忆接口返回摘要', async () => {
  await withApp(async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '记忆乙' }));
    const started = await startCard(app, imported.card.id);
    const sessionId = started.session.id;

    for (let round = 1; round <= 20; round += 1) {
      const events = await send(app, sessionId, `第${round}轮：今天还好吗？`);
      assert.equal(events.at(-1).event, 'done');
    }

    const withSummary = await waitFor(async () => {
      const page = await memoryOf(app, sessionId);
      return page.body.summaries.length > 0 ? page : null;
    }, { label: 'summary created' });

    const summary = withSummary.body.summaries[0];
    assert.match(summary.content, /面试/);
    assert.ok(summary.content.length <= 300);
    assert.equal(summary.from_msg_id, 1);
    assert.equal(summary.to_msg_id, 40);

    const missing = await memoryOf(app, 999999);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'session_not_found');
  });
});
