import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

async function saveLlm(app, llm) {
  const response = await fetch(`${app.baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ llm }),
  });
  return { status: response.status, body: await response.json() };
}

test('页面上有模型设置入口和四个字段，密钥不回显明文', async () => {
  await withApp(async (app) => {
    const page = await fetch(`${app.baseUrl}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /id="settingsOpen"/);
    assert.match(html, /aria-label="模型设置"/);
    assert.match(html, /id="settingsDialog"/);
    for (const id of ['llmBaseUrl', 'llmApiKey', 'llmChatModel', 'llmUtilityModel']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /内容由模型生成，请自行判断/);
    assert.doesNotMatch(html, /风格|温度|供应商|回退/);

    const script = await (await fetch(`${app.baseUrl}/app.js`)).text();
    assert.match(script, /\/api\/config/);
    assert.doesNotMatch(script, /localStorage|sessionStorage/);
  });
});

test('保存模型设置后下一句就用新模型，密钥留空不覆盖', async () => {
  await withApp(async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '换模型甲' }));
    const started = await startCard(app, imported.card.id);
    const id = started.session.id;

    await send(app, id, '在吗？');
    assert.equal((await fake.lastStreamRequest()).model, 'fake-ok');

    const view = await (await fetch(`${app.baseUrl}/api/config`)).json();
    assert.match(view.config.llm.api_key, /^\*{4}-key$/);

    const saved = await saveLlm(app, {
      base_url: fake.baseUrl,
      api_key: '',
      chat_model: 'fake-restate',
      utility_model: 'fake-restate',
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.config.llm.chat_model, 'fake-restate');
    assert.equal(saved.body.config.llm.api_key, '****-key');

    const onDisk = JSON.parse(readFileSync(path.join(app.dataDir, 'config.json'), 'utf8'));
    assert.equal(onDisk.llm.api_key, 'test-key');
    assert.equal(onDisk.llm.chat_model, 'fake-restate');

    const events = await send(app, id, '再说一句');
    assert.equal((await fake.lastStreamRequest()).model, 'fake-restate');
    assert.ok(events.some((event) => event.event === 'done'), JSON.stringify(events));
  });
});

test('模型设置填错时返回中文错误且不写盘', async () => {
  await withApp(async (app) => {
    const before = readFileSync(path.join(app.dataDir, 'config.json'), 'utf8');

    const badType = await saveLlm(app, { chat_model: 42 });
    assert.equal(badType.status, 400);
    assert.equal(badType.body.error.code, 'config_invalid');
    assert.ok(badType.body.error.message.length > 0);
    assert.doesNotMatch(badType.body.error.message, /额度|配额|余额|error/i);

    const badKey = await saveLlm(app, { nope: 'x' });
    assert.equal(badKey.status, 400);

    assert.equal(readFileSync(path.join(app.dataDir, 'config.json'), 'utf8'), before);
  });
});
