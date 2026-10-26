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

const baseLlm = {
  api_key: 'test-key',
  chat_timeout_ms: 3000,
  utility_timeout_ms: 3000,
};

function configFor(model, extra = {}) {
  return {
    ...extra,
    llm: {
      ...baseLlm,
      base_url: fake.baseUrl,
      chat_model: model,
      utility_model: model,
      ...(extra.llm ?? {}),
    },
  };
}

async function withApp(model, fn, extra = {}) {
  const app = await startApp({ config: configFor(model, extra) });
  try {
    await fn(app);
  } finally {
    await app.stop();
  }
}

async function importCard(app, card) {
  const bytes = jsonBytes(card);
  const preview = await fetch(`${app.baseUrl}/api/cards/preview`, {
    method: 'POST',
    headers: { 'X-Filename': encodeURIComponent(`${card.data.name}.json`) },
    body: bytes,
  });
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();

  const commit = await fetch(`${app.baseUrl}/api/cards/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: previewBody.token, mode: 'new' }),
  });
  assert.equal(commit.status, 200);
  return commit.json();
}

async function startCard(app, cardId) {
  const response = await fetch(`${app.baseUrl}/api/cards/${cardId}/start`, { method: 'POST' });
  assert.equal(response.status, 200);
  return response.json();
}

async function send(app, sessionId, text) {
  const response = await fetch(`${app.baseUrl}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    return { status: response.status, body: await response.json(), events: [] };
  }
  const events = await readSseEvents(response, {
    until: (event) => event.event === 'done' || event.event === 'error',
  });
  return { status: response.status, events };
}

async function history(app, sessionId, query = '') {
  const response = await fetch(`${app.baseUrl}/api/sessions/${sessionId}/messages${query}`);
  return { status: response.status, body: await response.json() };
}

function openDb(app) {
  const db = new DatabaseSync(path.join(app.dataDir, 'companion.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function sessionRow(app, sessionId) {
  const db = openDb(app);
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) ?? null;
  db.close();
  return row;
}

function charMessages(app, sessionId) {
  const db = openDb(app);
  const rows = db
    .prepare("SELECT * FROM messages WHERE session_id = ? AND role = 'char' ORDER BY id ASC")
    .all(sessionId);
  db.close();
  return rows;
}

function setSessionState(app, sessionId, state) {
  const db = openDb(app);
  db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(state, sessionId);
  db.close();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('发送后按 user_ack → bubble → done 返回，并把消息与用量落库', async () => {
  await withApp('fake-ok', async (app) => {
    const imported = await importCard(app, makeV2Card({
      name: '对话甲',
      description: '住得近，偶尔一起吃饭。',
    }));
    const started = await startCard(app, imported.card.id);

    const result = await send(app, started.session.id, '在吗？');

    assert.equal(result.status, 200);
    assert.equal(result.events[0].event, 'user_ack');
    assert.equal(result.events.at(-1).event, 'done');

    const bubbles = result.events.filter((event) => event.event === 'bubble');
    assert.ok(bubbles.length >= 1);
    assert.equal(bubbles.map((event) => event.data.text).join(''), '嗯，我在。');

    const done = result.events.at(-1).data;
    assert.ok(done.tokens > 0);
    assert.equal(done.estimated, false);
    assert.equal(done.quota.limit, 500000);
    assert.ok(done.quota.used > 0);
    assert.equal(done.quota.warn, false);

    const page = await history(app, started.session.id);
    assert.deepEqual(page.body.messages.map((message) => message.role), ['user', 'char']);
    assert.equal(page.body.messages[0].content, '在吗？');
    assert.equal(page.body.messages[1].content, '嗯，我在。');

    const session = sessionRow(app, started.session.id);
    assert.ok(session.last_user_msg_at);
    assert.equal(session.token_used, done.tokens);

    const db = openDb(app);
    const ledger = db
      .prepare("SELECT * FROM token_ledger WHERE session_id = ? AND kind = 'chat'")
      .all(started.session.id);
    db.close();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amount, done.tokens);
  });
});

test('T1：整段书面语被拆成 1–3 条气泡，style_flags 记 split', async () => {
  await withApp('fake-long', async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '对话乙' }));
    const started = await startCard(app, imported.card.id);

    const result = await send(app, started.session.id, '今天怎么样？');
    const bubbles = result.events.filter((event) => event.event === 'bubble');

    assert.ok(bubbles.length >= 1 && bubbles.length <= 3);
    assert.match(bubbles.map((event) => event.data.text).join(''), /薄荷/);

    const rows = charMessages(app, started.session.id);
    assert.equal(rows.length, bubbles.length);
    for (const row of rows) {
      const flags = JSON.parse(row.style_flags);
      assert.equal(flags.split, true);
    }
  });
});

test('T2：客服腔先重生成，最终消息不含“请澄清您的需求”', async () => {
  await withApp('fake-restate', async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '对话丙' }));
    const started = await startCard(app, imported.card.id);

    const result = await send(app, started.session.id, '周三还是周四？');
    const bubbles = result.events.filter((event) => event.event === 'bubble');
    const text = bubbles.map((event) => event.data.text).join('');

    assert.ok(bubbles.length >= 1);
    assert.doesNotMatch(text, /请澄清/);

    const rows = charMessages(app, started.session.id);
    const flags = JSON.parse(rows[0].style_flags);
    assert.equal(flags.regenerated, true);
    assert.equal(flags.blacklist, false);
    assert.doesNotMatch(rows.map((row) => row.content).join(''), /请澄清/);
  });
});

test('重生成后仍全是黑名单句：发 style_blocked，不落角色消息，用户消息保留', async () => {
  await withApp('fake-system', async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '对话庚' }));
    const started = await startCard(app, imported.card.id);

    const result = await send(app, started.session.id, '在吗？');
    assert.equal(result.status, 200);
    assert.equal(result.events[0].event, 'user_ack');
    assert.equal(result.events.at(-1).event, 'error');
    assert.equal(result.events.at(-1).data.code, 'style_blocked');

    const page = await history(app, started.session.id);
    assert.deepEqual(page.body.messages.map((message) => message.role), ['user']);
    assert.equal(page.body.messages[0].content, '在吗？');

    const session = sessionRow(app, started.session.id);
    assert.equal(session.token_used, 0);
  });
});

test('第二次仍有黑名单句时截断该句，保留可用气泡并记 truncated', async () => {
  await withApp('fake-mixed', async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '对话辛' }));
    const started = await startCard(app, imported.card.id);

    const result = await send(app, started.session.id, '今天怎么样？');
    const bubbles = result.events.filter((event) => event.event === 'bubble');

    assert.equal(result.events.at(-1).event, 'done');
    assert.equal(bubbles.length, 1);
    assert.equal(bubbles[0].data.text, '今天有点累。');

    const rows = charMessages(app, started.session.id);
    assert.equal(rows.length, 1);
    const flags = JSON.parse(rows[0].style_flags);
    assert.equal(flags.regenerated, true);
    assert.equal(flags.truncated, true);
    assert.equal(flags.blacklist, true);
    assert.doesNotMatch(rows[0].content, /额度|作为 AI/);
  });
});

test('前置错误走 4xx JSON：未开始、不方便、空文本、未知会话都不落库', async () => {
  await withApp('fake-ok', async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '对话丁' }));
    const sessionId = imported.session.id;

    const notStarted = await send(app, sessionId, '在吗？');
    assert.equal(notStarted.status, 409);
    assert.equal(notStarted.body.error.code, 'session_not_started');

    await startCard(app, imported.card.id);
    setSessionState(app, sessionId, 'dormant');

    const dormant = await send(app, sessionId, '在吗？');
    assert.equal(dormant.status, 409);
    assert.equal(dormant.body.error.code, 'session_cannot_generate');

    setSessionState(app, sessionId, 'active');

    const empty = await send(app, sessionId, '   ');
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'message_empty');

    const missing = await send(app, 999999, '在吗？');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'session_not_found');

    const page = await history(app, sessionId);
    assert.deepEqual(page.body.messages, []);
  });
});

test('paused 仍能对话，历史分页倒序取正序返', async () => {
  await withApp('fake-ok', async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '对话戊' }));
    const started = await startCard(app, imported.card.id);
    const sessionId = started.session.id;

    setSessionState(app, sessionId, 'paused');

    for (const text of ['第一句', '第二句', '第三句']) {
      const result = await send(app, sessionId, text);
      assert.equal(result.status, 200);
      assert.equal(result.events.at(-1).event, 'done');
    }

    const all = await history(app, sessionId);
    assert.equal(all.body.messages.length, 6);
    assert.deepEqual(
      all.body.messages.map((message) => message.role),
      ['user', 'char', 'user', 'char', 'user', 'char'],
    );

    const page = await history(app, sessionId, '?limit=2');
    assert.equal(page.body.messages.length, 2);
    assert.equal(page.body.messages[0].content, '第三句');
    assert.equal(page.body.messages[1].role, 'char');

    const older = await history(app, sessionId, `?limit=2&before=${page.body.messages[0].id}`);
    assert.equal(older.body.messages.length, 2);
    assert.equal(older.body.messages[0].content, '第二句');
    assert.equal(older.body.messages[1].role, 'char');

    const bad = await history(app, sessionId, '?before=abc');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'invalid_pagination');
  });
});

test('全局 SSE 推送新消息，70% 阈值只发一次 quota', async () => {
  await withApp('fake-ok', async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '对话己' }));
    const started = await startCard(app, imported.card.id);
    const sessionId = started.session.id;

    const controller = new AbortController();
    const response = await fetch(`${app.baseUrl}/api/events`, { signal: controller.signal });
    await delay(100);
    const reading = readSseEvents(response, { signal: controller.signal });

    const first = await send(app, sessionId, '第一句');
    assert.equal(first.events.at(-1).event, 'done');
    assert.equal(first.events.at(-1).data.quota.warn, true);
    assert.equal(first.events.at(-1).data.quota.used, 15);

    const second = await send(app, sessionId, '第二句');
    assert.equal(second.events.at(-1).event, 'done');
    assert.equal(second.events.at(-1).data.quota.warn, true);
    assert.equal(second.events.at(-1).data.quota.used, 30);

    await delay(150);
    controller.abort();
    const events = await reading;

    assert.equal(events.filter((event) => event.event === 'quota').length, 1);
    assert.ok(events.filter((event) => event.event === 'message').length >= 4);

    const session = sessionRow(app, sessionId);
    assert.equal(session.quota70_flagged, 1);
  }, { quota: { default_token_limit: 20 } });
});
