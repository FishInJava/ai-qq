import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractCharaText } from '../../src/cards/png.js';
import { startApp } from '../helpers/start-app.js';
import {
  jsonBytes,
  makePngCard,
  makeV1Card,
  makeV2Card,
} from '../helpers/card-fixtures.js';

let app;
let jsonCardId;
let jsonCardText;
let pngCardId;
let pngCardBytes;

before(async () => {
  app = await startApp();
});

after(async () => {
  await app?.stop();
});

async function preview(bytes, filename) {
  const response = await fetch(`${app.baseUrl}/api/cards/preview`, {
    method: 'POST',
    headers: { 'X-Filename': encodeURIComponent(filename) },
    body: bytes,
  });
  return { status: response.status, body: await response.json() };
}

async function commit(token, mode = 'new') {
  const response = await fetch(`${app.baseUrl}/api/cards/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, mode }),
  });
  return { status: response.status, body: await response.json() };
}

async function importCard(bytes, filename) {
  const previewed = await preview(bytes, filename);
  assert.equal(previewed.status, 200);
  const committed = await commit(previewed.body.token, 'new');
  assert.equal(committed.status, 200);
  return committed.body;
}

async function exportCard(id, format) {
  const response = await fetch(`${app.baseUrl}/api/cards/${id}/export?format=${format}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    disposition: response.headers.get('content-disposition') ?? '',
    bytes,
    json: () => JSON.parse(bytes.toString('utf8')),
  };
}

async function list() {
  const response = await fetch(`${app.baseUrl}/api/cards`);
  assert.equal(response.status, 200);
  return response.json();
}

async function startCard(id) {
  const response = await fetch(`${app.baseUrl}/api/cards/${id}/start`, { method: 'POST' });
  return { status: response.status, body: await response.json() };
}

async function removeCard(id, scope) {
  const query = scope === undefined ? '' : `?scope=${scope}`;
  const response = await fetch(`${app.baseUrl}/api/cards/${id}${query}`, { method: 'DELETE' });
  return { status: response.status, body: await response.json() };
}

function openDb() {
  const db = new DatabaseSync(path.join(app.dataDir, 'companion.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function seedSession(sessionId) {
  const db = openDb();
  const now = new Date().toISOString();
  const message = db
    .prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, 'user', '测试消息', now);
  const messageId = Number(message.lastInsertRowid);

  db.prepare(`
    INSERT INTO facts (session_id, subject, key, value, status, valid_from)
    VALUES (?, 'user', '测试', '值', 'done', ?)
  `).run(sessionId, now);
  db.prepare(`
    INSERT INTO summaries (session_id, from_msg_id, to_msg_id, content, created_at)
    VALUES (?, ?, ?, '摘要', ?)
  `).run(sessionId, messageId, messageId, now);
  db.prepare(`
    INSERT INTO life_events (session_id, event_date, ordinal, content, created_at)
    VALUES (?, '2026-10-26', 0, '事件', ?)
  `).run(sessionId, now);
  db.prepare(`
    INSERT INTO proactive_log (session_id, content, fingerprint, created_at)
    VALUES (?, '主动', ?, ?)
  `).run(sessionId, `fp-${sessionId}`, now);
  db.prepare(`
    INSERT INTO daily_budget (date, session_id, used) VALUES ('2026-10-26', ?, 1)
  `).run(sessionId);
  db.prepare(`
    INSERT INTO token_ledger (session_id, kind, amount, estimated, created_at)
    VALUES (?, 'chat', 10, 0, ?)
  `).run(sessionId, now);
  db.prepare(`
    INSERT INTO scheduler_state (session_id, trigger, decision, decision_reason, created_at)
    VALUES (?, 'timer', 'skip', 'too_soon', ?)
  `).run(sessionId, now);

  db.close();
}

function sessionRow(sessionId) {
  const db = openDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) ?? null;
  db.close();
  return row;
}

function characterRow(id) {
  const db = openDb();
  const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) ?? null;
  db.close();
  return row;
}

function childCounts(sessionId) {
  const tables = [
    'messages',
    'facts',
    'summaries',
    'life_events',
    'proactive_log',
    'daily_budget',
    'token_ledger',
    'scheduler_state',
  ];
  const db = openDb();
  const counts = {};
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId);
    counts[table] = Number(row.n);
  }
  db.close();
  return counts;
}

test('JSON 导出逐字节等于导入的原始文本', async () => {
  const card = makeV2Card({
    name: '导出甲',
    description: '用来验证 JSON 导出不改一个字节。',
    tags: ['导出'],
  });
  const bytes = jsonBytes(card);
  jsonCardText = bytes.toString('utf8');
  const imported = await importCard(bytes, '导出甲.json');
  jsonCardId = imported.card.id;

  const exported = await exportCard(jsonCardId, 'json');

  assert.equal(exported.status, 200);
  assert.match(exported.contentType, /application\/json/);
  assert.match(exported.disposition, /^attachment;/);
  assert.match(exported.disposition, /filename\*=UTF-8''/);
  assert.match(exported.disposition, /\.json/);
  assert.deepEqual(exported.bytes, bytes);
});

test('PNG 导出复用原图字节，其余 chunk 原样保留', async () => {
  pngCardBytes = makePngCard(makeV2Card({
    name: '导出乙',
    description: '这张卡用来验证 PNG 原样导出。',
  }));
  const imported = await importCard(pngCardBytes, '导出乙.png');
  pngCardId = imported.card.id;

  const exported = await exportCard(pngCardId, 'png');

  assert.equal(exported.status, 200);
  assert.match(exported.contentType, /image\/png/);
  assert.match(exported.disposition, /\.png/);
  assert.deepEqual(exported.bytes, pngCardBytes);
});

test('JSON 卡导出 PNG 时用占位图包住同一份原始文本', async () => {
  const exported = await exportCard(jsonCardId, 'png');

  assert.equal(exported.status, 200);
  assert.match(exported.contentType, /image\/png/);
  assert.equal(extractCharaText(exported.bytes), jsonCardText);

  const reimported = await preview(exported.bytes, '导出甲.png');
  assert.equal(reimported.status, 200);
  assert.equal(reimported.body.duplicate.id, jsonCardId);
});

test('V1 卡导出 JSON 也逐字节一致', async () => {
  const bytes = jsonBytes(makeV1Card({ name: '导出丙', description: '旧格式的卡。' }));
  const imported = await importCard(bytes, '导出丙.json');

  const exported = await exportCard(imported.card.id, 'json');

  assert.equal(exported.status, 200);
  assert.deepEqual(exported.bytes, bytes);
});

test('T10：多张 V2 卡与带脚本卡导出逐字节一致', async () => {
  const variants = [
    { name: '兼容一', description: '普通 V2 卡。', tags: ['日常'] },
    { name: '兼容二', description: '带世界书的卡。', characterBook: { name: '书', entries: [] } },
    { name: '兼容三', description: '带正则脚本的卡。', extensions: { regex_scripts: [{ scriptName: 'x' }] } },
    { name: '兼容四', description: '带 STscript 的卡。', extensions: { stscript: '// script' } },
    {
      name: '兼容五',
      description: '带额外字段的卡。',
      system_prompt: '保持简短。',
      post_history_instructions: '不要复述。',
      alternate_greetings: ['另一种开场。'],
    },
  ];

  for (const [index, overrides] of variants.entries()) {
    const bytes = jsonBytes(makeV2Card(overrides));
    const imported = await importCard(bytes, `兼容-${index}.json`);
    const exported = await exportCard(imported.card.id, 'json');
    assert.equal(exported.status, 200);
    assert.deepEqual(exported.bytes, bytes, `第 ${index + 1} 张卡应逐字节一致`);
  }
});

test('未知格式与不存在的卡给出明确错误', async () => {
  const badFormat = await exportCard(jsonCardId, 'webp');
  assert.equal(badFormat.status, 400);
  assert.equal(badFormat.json().error.code, 'invalid_format');

  const missing = await exportCard(999999, 'json');
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error.code, 'card_not_found');
});

test('仅删卡：角色与文件消失，会话和记录留在库里', async () => {
  const card = makeV2Card({ name: '仅删卡', description: '删卡后记录还在。' });
  const bytes = jsonBytes(card);
  const imported = await importCard(bytes, '仅删卡.json');
  const cardId = imported.card.id;
  const sessionId = imported.session.id;

  const started = await startCard(cardId);
  assert.equal(started.body.session.state, 'active');
  seedSession(sessionId);

  const sourcePath = path.join(app.dataDir, 'cards', `${cardId}.json`);
  assert.equal(existsSync(sourcePath), true);

  const removed = await removeCard(cardId, 'card');
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { ok: true });

  const library = await list();
  assert.equal(library.cards.some((item) => item.id === cardId), false);
  assert.equal(characterRow(cardId), null);
  assert.equal(existsSync(sourcePath), false);

  const session = sessionRow(sessionId);
  assert.ok(session);
  assert.equal(session.character_id, null);

  const counts = childCounts(sessionId);
  for (const [table, count] of Object.entries(counts)) {
    assert.equal(count, 1, `${table} 应保留`);
  }
});

test('连记录删除：会话与所有级联表清空，头像与卡文件一起删掉', async () => {
  const bytes = makePngCard(makeV2Card({
    name: '连记录删',
    description: '这张卡连同记录一起删。',
  }));
  const imported = await importCard(bytes, '连记录删.png');
  const cardId = imported.card.id;
  const sessionId = imported.session.id;

  const started = await startCard(cardId);
  assert.equal(started.body.session.state, 'active');
  seedSession(sessionId);

  const sourcePath = path.join(app.dataDir, 'cards', `${cardId}.png`);
  const avatarPath = path.join(app.dataDir, 'avatars', `${cardId}.png`);
  assert.equal(existsSync(sourcePath), true);
  assert.equal(existsSync(avatarPath), true);

  const removed = await removeCard(cardId, 'records');
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { ok: true });

  assert.equal(characterRow(cardId), null);
  assert.equal(sessionRow(sessionId), null);
  assert.equal(existsSync(sourcePath), false);
  assert.equal(existsSync(avatarPath), false);

  const counts = childCounts(sessionId);
  for (const [table, count] of Object.entries(counts)) {
    assert.equal(count, 0, `${table} 应清空`);
  }

  const avatar = await fetch(`${app.baseUrl}/api/cards/${cardId}/avatar`);
  assert.equal(avatar.status, 404);
});

test('删除范围不对与重复删除给出明确错误', async () => {
  const card = makeV2Card({ name: '删除校验', description: '校验错误分支。' });
  const imported = await importCard(jsonBytes(card), '删除校验.json');

  const badScope = await removeCard(imported.card.id, 'everything');
  assert.equal(badScope.status, 400);
  assert.equal(badScope.body.error.code, 'invalid_scope');

  const first = await removeCard(imported.card.id, 'card');
  assert.equal(first.status, 200);

  const again = await removeCard(imported.card.id, 'card');
  assert.equal(again.status, 404);
  assert.equal(again.body.error.code, 'card_not_found');
});
