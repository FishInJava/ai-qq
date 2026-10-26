import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
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

function config() {
  return {
    llm: {
      base_url: fake.baseUrl,
      api_key: 'test-key',
      chat_model: 'fake-ok',
      utility_model: 'fake-living-ok',
      chat_timeout_ms: 5000,
      utility_timeout_ms: 5000,
    },
  };
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
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text }),
  });
  assert.equal(response.status, 200);
  return readSseEvents(response, {
    until: (event) => event.event === 'done' || event.event === 'error',
  });
}

async function history(app, sessionId) {
  return (await (await fetch(`${app.baseUrl}/api/sessions/${sessionId}/messages?limit=100`)).json()).messages;
}

test('T14：强杀后重启，库完好、状态保留、历史不重复、不补发历史消息', async () => {
  const first = await startApp({ config: config(), keepData: true });
  const dataDir = first.dataDir;
  let second = null;
  try {
    const imported = await importCard(first, makeV2Card({ name: '崩恢复甲' }));
    const started = await startCard(first, imported.card.id);
    const id = started.session.id;

    const events = await send(first, id, '我先说一句。');
    assert.equal(events.at(-1).event, 'done');
    const before = await history(first, id);
    assert.ok(before.length >= 2);

    const exited = new Promise((resolve) => first.child.once('exit', resolve));
    first.child.kill('SIGKILL');
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('kill timeout')), 3000)),
    ]);

    second = await startApp({ config: config(), dataDir, keepData: true });
    const cards = await (await fetch(`${second.baseUrl}/api/cards`)).json();
    const card = cards.cards.find((item) => item.id === imported.card.id);
    assert.ok(card);
    assert.equal(card.state, 'active');
    assert.equal(card.state_word, '醒着');
    assert.equal(card.session_id, id);

    const afterRestart = await history(second, id);
    assert.deepEqual(
      afterRestart.map((message) => message.id),
      before.map((message) => message.id),
    );

    const more = await send(second, id, '我回来了。');
    assert.equal(more.at(-1).event, 'done');
    const afterMore = await history(second, id);
    assert.equal(new Set(afterMore.map((message) => message.id)).size, afterMore.length);
  } finally {
    await first.stop();
    await second?.stop();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
