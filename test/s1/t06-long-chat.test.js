import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

function configFor(model) {
  return {
    llm: {
      base_url: fake.baseUrl,
      api_key: 'test-key',
      chat_model: model,
      utility_model: model,
      chat_timeout_ms: 5000,
      utility_timeout_ms: 5000,
    },
  };
}

async function withApp(fn) {
  const app = await startApp({ config: configFor('fake-ok') });
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

function openDb(app) {
  const db = new DatabaseSync(path.join(app.dataDir, 'companion.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

test('连续 20 轮对话全部完成，历史与 token 账本完整', async () => {
  await withApp(async (app) => {
    const imported = await importCard(app, makeV2Card({
      name: '长对话',
      description: '住得近，偶尔一起吃饭。',
    }));
    const started = await startCard(app, imported.card.id);
    const sessionId = started.session.id;

    let totalTokens = 0;
    for (let round = 1; round <= 20; round += 1) {
      const events = await send(app, sessionId, `第${round}轮：今天还好吗？`);
      assert.equal(events.at(-1).event, 'done', `round ${round} did not finish`);
      totalTokens += events.at(-1).data.tokens;
    }

    const historyResponse = await fetch(
      `${app.baseUrl}/api/sessions/${sessionId}/messages?limit=100`,
    );
    const history = await historyResponse.json();
    assert.equal(history.messages.length, 40);
    assert.equal(history.messages[0].content, '第1轮：今天还好吗？');
    assert.equal(history.messages[1].role, 'char');
    assert.equal(history.messages.at(-1).role, 'char');

    const db = openDb(app);
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    const ledger = db
      .prepare("SELECT * FROM token_ledger WHERE session_id = ? AND kind = 'chat' ORDER BY id ASC")
      .all(sessionId);
    db.close();

    assert.equal(ledger.length, 20);
    assert.equal(ledger.reduce((sum, row) => sum + row.amount, 0), totalTokens);
    assert.equal(session.token_used, totalTokens);
    assert.ok(session.last_user_msg_at);
  });
});
