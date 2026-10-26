import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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
  const previewBody = await preview.json();
  assert.equal(preview.status, 200, JSON.stringify(previewBody));
  const commit = await fetch(`${app.baseUrl}/api/cards/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: previewBody.token, mode: 'new' }),
  });
  const commitBody = await commit.json();
  assert.equal(commit.status, 200, JSON.stringify(commitBody));
  return commitBody;
}

async function startCard(app, cardId) {
  const response = await fetch(`${app.baseUrl}/api/cards/${cardId}/start`, { method: 'POST' });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function send(app, sessionId, text) {
  const response = await fetch(`${app.baseUrl}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text }),
  });
  const events = await readSseEvents(response, {
    until: (event) => event.event === 'done' || event.event === 'error',
  });
  return { status: response.status, events };
}

async function patchSession(app, sessionId, body) {
  const response = await fetch(`${app.baseUrl}/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectStrings(item, out);
    }
  }
  return out;
}

test('会话 PATCH、续额与好转：额度只影响界面，不进入对话', async () => {
  await withApp('fake-ok', async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '会话甲' }));
    const started = await startCard(app, imported.card.id);
    const id = started.session.id;

    assert.equal((await patchSession(app, id, {})).status, 400);
    assert.equal((await patchSession(app, id, { active: 'yes' })).status, 400);
    assert.equal((await patchSession(app, id, { token_limit: 0 })).status, 400);
    assert.equal((await patchSession(app, 999999, { active: false })).status, 404);

    const paused = await patchSession(app, id, { active: false });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.session.state, 'paused');
    assert.equal(paused.body.session.state_word, '在忙');
    const resumed = await patchSession(app, id, { active: true });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.session.state, 'active');

    const refillResponse = await fetch(`${app.baseUrl}/api/sessions/${id}/refill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 1000 }),
    });
    const refilled = await refillResponse.json();
    assert.equal(refillResponse.status, 200, JSON.stringify(refilled));
    assert.equal(refilled.session.token_limit, 501000);
    assert.equal(refilled.session.token_used, 0);
    assert.equal(refilled.quota.status, 'ok');

    const first = await send(app, id, '在吗？');
    assert.equal(first.events.at(-1).event, 'done');
    const firstPrompt = (await fake.lastStreamRequest()).messages
      .map((message) => message.content)
      .join('\n');
    assert.match(firstPrompt, /好转/);

    const second = await send(app, id, '今天怎么样？');
    assert.equal(second.events.at(-1).event, 'done');
    const secondPrompt = (await fake.lastStreamRequest()).messages
      .map((message) => message.content)
      .join('\n');
    assert.doesNotMatch(secondPrompt, /好转/);

    const tiny = await patchSession(app, id, { token_limit: 1 });
    assert.equal(tiny.status, 200);
    assert.equal(tiny.body.session.state, 'dormant');
    const illegal = await patchSession(app, id, { active: false });
    assert.equal(illegal.status, 409);

    const revived = await fetch(`${app.baseUrl}/api/sessions/${id}/refill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100 }),
    });
    const revivedBody = await revived.json();
    assert.equal(revived.status, 200, JSON.stringify(revivedBody));
    assert.equal(revivedBody.session.state, 'active');

    const badRefill = await fetch(`${app.baseUrl}/api/sessions/${id}/refill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 0 }),
    });
    assert.equal(badRefill.status, 400);

    const usageResponse = await fetch(`${app.baseUrl}/api/usage`);
    const usage = await usageResponse.json();
    assert.equal(usageResponse.status, 200);
    assert.ok(usage.daily[0].chat > 0);
    assert.ok(usage.entries.some((entry) => entry.kind === 'refill'));
    assert.ok(usage.sessions.some((row) => row.session_id === id));

    for (const query of ['?from=2026-02-30', '?from=2026-03-02&to=2026-03-01']) {
      const bad = await fetch(`${app.baseUrl}/api/usage${query}`);
      assert.equal(bad.status, 400);
    }
  });
});

test('配置：GET 脱敏、PUT 部分保存、非法字段拒绝', async () => {
  await withApp('fake-ok', async (app) => {
    const getResponse = await fetch(`${app.baseUrl}/api/config`);
    const initial = await getResponse.json();
    assert.equal(getResponse.status, 200);
    assert.match(initial.config.llm.api_key, /^\*{4}-key$/);
    assert.notEqual(initial.config.llm.api_key, 'test-key');

    const putResponse = await fetch(`${app.baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        llm: { chat_model: 'fake-long', api_key: '' },
        schedule: { cooldown_min: 5 },
      }),
    });
    const saved = await putResponse.json();
    assert.equal(putResponse.status, 200, JSON.stringify(saved));
    assert.equal(saved.config.llm.chat_model, 'fake-long');
    assert.equal(saved.config.schedule.cooldown_min, 5);
    assert.match(saved.config.llm.api_key, /^\*{4}-key$/);
    assert.equal(saved.restart_required, false);

    const onDisk = JSON.parse(readFileSync(path.join(app.dataDir, 'config.json'), 'utf8'));
    assert.equal(onDisk.llm.api_key, 'test-key');
    assert.equal(onDisk.schedule.cooldown_min, 5);

    const restart = await fetch(`${app.baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtime: { test_hooks: true } }),
    });
    assert.equal(restart.status, 200);
    assert.equal((await restart.json()).restart_required, true);

    for (const body of [
      { server: { host: '0.0.0.0' } },
      { budget: { daily_global: '5' } },
      { nope: true },
      { llm: 'bad' },
    ]) {
      const response = await fetch(`${app.baseUrl}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
  });
});

test('管理员：同源校验、暂停全部、清空前备份、优雅退出', async () => {
  const app = await startApp({ config: configFor('fake-ok') });
  try {
    const imported = await importCard(app, makeV2Card({ name: '管理甲' }));
    const started = await startCard(app, imported.card.id);

    const crossOrigin = await fetch(`${app.baseUrl}/api/admin/pause-all`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example' },
    });
    assert.equal(crossOrigin.status, 403);

    const pauseResponse = await fetch(`${app.baseUrl}/api/admin/pause-all`, {
      method: 'POST',
      headers: { Origin: app.baseUrl },
    });
    const paused = await pauseResponse.json();
    assert.equal(pauseResponse.status, 200);
    assert.equal(paused.paused, 1);

    const cardsAfterPause = await (await fetch(`${app.baseUrl}/api/cards`)).json();
    assert.equal(cardsAfterPause.cards[0].state, 'paused');

    const wrongConfirm = await fetch(`${app.baseUrl}/api/admin/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'delete' }),
    });
    assert.equal(wrongConfirm.status, 400);

    const purgeResponse = await fetch(`${app.baseUrl}/api/admin/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    const purged = await purgeResponse.json();
    assert.equal(purgeResponse.status, 200, JSON.stringify(purged));
    assert.match(purged.backup, /^companion\.backup-.+\.db$/);
    assert.equal(existsSync(path.join(app.dataDir, purged.backup)), true);
    assert.equal(existsSync(path.join(app.dataDir, 'cards')), false);
    assert.equal(existsSync(path.join(app.dataDir, 'avatars')), false);

    const cardsAfterPurge = await (await fetch(`${app.baseUrl}/api/cards`)).json();
    assert.equal(cardsAfterPurge.cards.length, 0);
    assert.ok(started.session.id > 0);

    const exited = new Promise((resolve) => app.child.once('exit', resolve));
    const quitResponse = await fetch(`${app.baseUrl}/api/admin/quit`, { method: 'POST' });
    assert.equal(quitResponse.status, 200);
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('quit timeout')), 3000)),
    ]);
  } finally {
    await app.stop();
  }
});

test('T7：不方便状态下所有接口都不出现系统腔', async () => {
  await withApp('fake-ok', async (app) => {
    const imported = await importCard(app, makeV2Card({ name: '安静甲' }));
    const started = await startCard(app, imported.card.id);
    const id = started.session.id;

    await patchSession(app, id, { token_limit: 1 });
    const message = await send(app, id, '在吗？');
    assert.equal(message.events.at(-1).event, 'done');
    const cards = await (await fetch(`${app.baseUrl}/api/cards`)).json();
    assert.equal(cards.cards.find((card) => card.id === imported.card.id).state, 'dormant');

    const endpoints = [
      '/api/cards',
      `/api/sessions/${id}/messages`,
      `/api/sessions/${id}/today`,
      `/api/sessions/${id}/memory`,
      `/api/sessions/${id}/debug/ticks`,
      '/api/usage',
      '/api/config',
    ];
    for (const endpoint of endpoints) {
      const response = await fetch(`${app.baseUrl}${endpoint}`);
      const text = await response.text();
      assert.equal(response.status, 200, `${endpoint}: ${text}`);
      const values = collectStrings(JSON.parse(text));
      for (const value of values) {
        assert.doesNotMatch(value, /额度|配额|余额|error/i, `${endpoint}: ${value}`);
      }
    }

    const blocked = await fetch(`${app.baseUrl}/api/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ text: '再说一句' }),
    });
    const blockedText = await blocked.text();
    assert.equal(blocked.status, 409);
    assert.match(blockedText, /不太方便/);
    for (const value of collectStrings(JSON.parse(blockedText))) {
      assert.doesNotMatch(value, /额度|配额|余额|error/i, value);
    }
  });
});

test('T9：暂停 5 小时后恢复，提示词带时间断层，首条带时间指涉', async () => {
  const config = configFor('fake-pause');
  let app = await startApp({ config, keepData: true });
  const dataDir = app.dataDir;
  try {
    const imported = await importCard(app, makeV2Card({ name: '久别甲' }));
    const started = await startCard(app, imported.card.id);
    const id = started.session.id;
    await send(app, id, '我出门了。');
    await patchSession(app, id, { active: false });

    const exited = new Promise((resolve) => app.child.once('exit', resolve));
    const quit = await fetch(`${app.baseUrl}/api/admin/quit`, { method: 'POST' });
    assert.equal(quit.status, 200);
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('quit timeout')), 3000)),
    ]);

    const db = new DatabaseSync(path.join(dataDir, 'companion.db'));
    const fiveHoursAgo = new Date(Date.now() - (5 * 60 * 60 * 1000)).toISOString();
    db.prepare('UPDATE sessions SET last_user_msg_at = ? WHERE id = ?').run(fiveHoursAgo, id);
    db.close();

    app = await startApp({ config, dataDir, keepData: true });
    const resumed = await patchSession(app, id, { active: true });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.session.state, 'active');

    const result = await send(app, id, '我回来了。');
    assert.equal(result.events.at(-1).event, 'done');
    const bubbles = result.events
      .filter((event) => event.event === 'bubble')
      .map((event) => event.data.text)
      .join('');
    assert.match(bubbles, /这么久|回来/);

    const prompt = (await fake.lastStreamRequest()).messages
      .map((message) => message.content)
      .join('\n');
    assert.match(prompt, /大约 5 小时/);
    assert.doesNotMatch(prompt, /pause_gap_hours/);
  } finally {
    await app.stop();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
