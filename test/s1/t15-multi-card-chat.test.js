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

function configFor(extra = {}) {
  return {
    ...extra,
    runtime: { test_hooks: true, cold_start_proactive: true, ...(extra.runtime ?? {}) },
    schedule: { cooldown_min: 0, willingness_threshold: 0, ...(extra.schedule ?? {}) },
    budget: { daily_global: 5, per_session: 2, ...(extra.budget ?? {}) },
    llm: {
      base_url: fake.baseUrl,
      api_key: 'test-key',
      chat_model: 'fake-proactive-ok',
      utility_model: 'fake-living-ok',
      chat_timeout_ms: 5000,
      utility_timeout_ms: 5000,
      ...(extra.llm ?? {}),
    },
  };
}

async function withApp(fn, extra = {}) {
  const app = await startApp({ config: configFor(extra) });
  try {
    await fn(app);
  } finally {
    await app.stop();
  }
}

async function importCard(app, name) {
  const card = makeV2Card({ name });
  const preview = await fetch(`${app.baseUrl}/api/cards/preview`, {
    method: 'POST',
    headers: { 'X-Filename': encodeURIComponent(`${name}.json`) },
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

async function tick(app, sessionId) {
  const response = await fetch(`${app.baseUrl}/api/test/tick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, trigger: 'manual' }),
  });
  return { status: response.status, body: await response.json() };
}

async function send(app, sessionId, text) {
  const response = await fetch(`${app.baseUrl}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text }),
  });
  assert.equal(response.status, 200);
  return readSseEvents(response, {
    until: (event) => event.event === 'done' || event.event === 'error',
  });
}

test('主动消息带 role、两卡不串台、多气泡同属一次生成', async () => {
  await withApp(async (app) => {
    const imported = await importCard(app, '主动甲');
    const started = await startCard(app, imported.card.id);
    await fetch(`${app.baseUrl}/api/sessions/${started.session.id}/today`);

    const result = await tick(app, started.session.id);
    assert.equal(result.status, 200);
    assert.equal(result.body.decision, 'send', JSON.stringify(result.body));

    const request = await fake.lastStreamRequest();
    assert.ok(Array.isArray(request.messages) && request.messages.length > 0);
    for (const [index, message] of request.messages.entries()) {
      assert.equal(typeof message.role, 'string', `messages[${index}] 缺 role`);
      assert.ok(['system', 'user', 'assistant'].includes(message.role), `messages[${index}] role=${message.role}`);
      assert.equal(typeof message.content, 'string', `messages[${index}] 缺 content`);
    }
    assert.equal(request.messages[0].role, 'system');
    assert.equal(request.messages.at(-1).role, 'user');
    assert.match(request.messages[0].content, /主动开口的规矩/);
    assert.match(request.messages[0].content, /主动甲/);

    const first = await importCard(app, '串台甲');
    const second = await importCard(app, '串台乙');
    const firstSession = (await startCard(app, first.card.id)).session.id;
    const secondSession = (await startCard(app, second.card.id)).session.id;

    await send(app, firstSession, '甲的第一句');
    await send(app, secondSession, '乙的第一句');

    const firstHistory = await (await fetch(`${app.baseUrl}/api/sessions/${firstSession}/messages`)).json();
    const secondHistory = await (await fetch(`${app.baseUrl}/api/sessions/${secondSession}/messages`)).json();

    assert.deepEqual(
      firstHistory.messages.filter((message) => message.role === 'user').map((message) => message.content),
      ['甲的第一句'],
    );
    assert.deepEqual(
      secondHistory.messages.filter((message) => message.role === 'user').map((message) => message.content),
      ['乙的第一句'],
    );
    assert.ok(firstHistory.messages.every((message) => message.session_id === undefined || message.session_id === firstSession));

    const switched = await fetch(`${app.baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: { chat_model: 'fake-long' } }),
    });
    assert.equal(switched.status, 200);

    const bubbleCard = await importCard(app, '气泡甲');
    const bubbleSession = (await startCard(app, bubbleCard.card.id)).session.id;
    const events = await send(app, bubbleSession, '说长一点');
    const bubbles = events.filter((event) => event.event === 'bubble');

    assert.ok(bubbles.length >= 2, JSON.stringify(events));
    assert.deepEqual(bubbles.map((event) => event.data.bubble_index), [0, 1]);

    const page = await (await fetch(`${app.baseUrl}/app.js`)).text();
    assert.match(page, /function groupMessages/);
    assert.match(page, /msg--group/);

    const css = await (await fetch(`${app.baseUrl}/styles.css`)).text();
    assert.match(css, /\.msg__bubbles\s*\{[^}]*flex-direction:\s*column/s);
  });
});
