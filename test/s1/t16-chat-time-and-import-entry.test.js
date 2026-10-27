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
    llm: {
      base_url: fake.baseUrl,
      api_key: 'test-key',
      chat_model: 'fake-ok',
      utility_model: 'fake-ok',
      chat_timeout_ms: 3000,
      utility_timeout_ms: 3000,
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

async function importCard(app, card) {
  const preview = await fetch(`${app.baseUrl}/api/cards/preview`, {
    method: 'POST',
    headers: { 'X-Filename': encodeURIComponent(`${card.data.name}.json`) },
    body: jsonBytes(card),
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
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text }),
  });
  assert.equal(response.status, 200);
  return readSseEvents(response, {
    until: (event) => event.event === 'done' || event.event === 'error',
  });
}

test('消息 SSE 事件带 created_at，前端能据此渲染时间与日期分隔行', async () => {
  await withApp(async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '时间甲' }));
    const started = await startCard(app, imported.card.id);
    const events = await send(app, started.session.id, '现在几点？');

    const ack = events.find((event) => event.event === 'user_ack');
    assert.ok(ack, JSON.stringify(events));
    assert.match(
      String(ack.data.created_at ?? ''),
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      '用户消息 ack 必须带 ISO 时间戳',
    );

    const bubbles = events.filter((event) => event.event === 'bubble');
    assert.ok(bubbles.length > 0, JSON.stringify(events));
    for (const bubble of bubbles) {
      assert.match(
        String(bubble.data.created_at ?? ''),
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
        '每条气泡都必须带 ISO 时间戳',
      );
    }

    const stamps = new Set(bubbles.map((bubble) => bubble.data.created_at));
    assert.equal(stamps.size, 1, '同批气泡的时间戳应一致');

    const history = await (await fetch(`${app.baseUrl}/api/sessions/${started.session.id}/messages`)).json();
    assert.ok(history.messages.length >= 2);
    for (const message of history.messages) {
      assert.match(
        String(message.created_at ?? ''),
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
        '历史消息必须带 created_at',
      );
    }
  });
});

test('任何状态下导入入口都只有一个，且删掉的重复入口不再回来', async () => {
  await withApp(async (app) => {
    const pageOf = async () => (await fetch(`${app.baseUrl}/`)).text();
    const countOf = (html, id) => (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;

    const empty = await pageOf();
    assert.equal(countOf(empty, 'stageImport'), 1, '空库时导入入口应恰好一个');
    assert.equal(countOf(empty, 'importZone'), 0, '左下角的重复入口必须已删除');
    assert.equal(countOf(empty, 'importOpen'), 0, '头部十字按钮必须已删除');

    const imported = await importCard(app, makeV2Card({ name: '入口甲' }));
    const intro = await pageOf();
    assert.equal(countOf(intro, 'stageImport'), 1, '选卡后导入入口仍应存在且只有一个');
    assert.equal(countOf(intro, 'importZone'), 0);

    await startCard(app, imported.card.id);
    const chat = await pageOf();
    assert.equal(countOf(chat, 'stageImport'), 1, '聊天中导入入口仍应存在且只有一个');
    assert.equal(countOf(chat, 'importZone'), 0);

    const script = await (await fetch(`${app.baseUrl}/app.js`)).text();
    assert.match(script, /stageImport/);
    assert.match(script, /openImport/);
    assert.doesNotMatch(script, /importZone/, '脚本不应再引用已删除的入口');
    assert.doesNotMatch(script, /importOpen/, '脚本不应再引用已删除的入口');
    assert.match(empty, /id="importDialog"/);
  });
});
