import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers/start-app.js';
import {
  jsonBytes,
  makePngCard,
  makeV1Card,
  makeV2Card,
} from '../helpers/card-fixtures.js';

let app;
let jsonCardId;
let jsonSessionId;
let jsonCardBytes;
let pngCard;
let pngCardId;
let pngSessionId;
let pngCardBytes;

before(async () => {
  app = await startApp();
});

after(async () => {
  await app?.stop();
});

async function preview(bytes, filename) {
  const headers = {};
  if (filename !== undefined) {
    headers['X-Filename'] = encodeURIComponent(filename);
  }
  const response = await fetch(`${app.baseUrl}/api/cards/preview`, {
    method: 'POST',
    headers,
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

async function list(q = '') {
  const query = q === '' ? '' : `?q=${encodeURIComponent(q)}`;
  const response = await fetch(`${app.baseUrl}/api/cards${query}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function startCard(id) {
  const response = await fetch(`${app.baseUrl}/api/cards/${id}/start`, {
    method: 'POST',
  });
  return { status: response.status, body: await response.json() };
}

test('预览 JSON 卡时能看到名字、描述、标签与兼容模式', async () => {
  const card = makeV2Card({
    name: '林夏',
    description: '住在城南的插画师，慢热，喜欢在雨天画画。',
    tags: ['日常', '慢热'],
  });

  const result = await preview(jsonBytes(card), '林夏.json');

  assert.equal(result.status, 200);
  assert.equal(typeof result.body.token, 'string');
  assert.equal(result.body.name, '林夏');
  assert.match(result.body.description, /插画师/);
  assert.deepEqual(result.body.tags, ['日常', '慢热']);
  assert.equal(result.body.compat, 'v2');
  assert.equal(result.body.has_scripts, false);
  assert.equal(result.body.has_book, false);
  assert.equal(result.body.duplicate, null);
});

test('预览 PNG 卡时从 chara 数据块读取', async () => {
  const card = makeV2Card({ name: '顾青', description: '楼下花店的老板。' });
  const bytes = makePngCard(card);

  const result = await preview(bytes, '顾青.png');

  assert.equal(result.status, 200);
  assert.equal(result.body.name, '顾青');
  assert.equal(result.body.compat, 'v2');
  assert.equal(result.body.duplicate, null);
});

test('解析失败时给出中文错误，角色库不新增', async () => {
  const before = await list();
  const card = makeV2Card({ name: '坏卡' });

  const noChara = await preview(makePngCard(card, { keyword: 'comment' }), '坏卡.png');
  assert.equal(noChara.status, 400);
  assert.equal(noChara.body.error.code, 'card_png_invalid');
  assert.match(noChara.body.error.message, /不是角色卡/);

  const badJson = await preview(Buffer.from('{ 这不是 JSON', 'utf8'), '坏卡.json');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error.code, 'card_json_invalid');

  const afterFailure = await list();
  assert.equal(afterFailure.cards.length, before.cards.length);
});

test('提交 JSON 卡后出现在角色库，状态是未开始', async () => {
  const card = makeV2Card({
    name: '周叙',
    description: '在赶稿的编剧，白天不太回消息。',
    tags: ['工作', '夜猫子'],
  });
  jsonCardBytes = jsonBytes(card);

  const previewed = await preview(jsonCardBytes, '周叙.json');
  assert.equal(previewed.status, 200);

  const committed = await commit(previewed.body.token, 'new');
  assert.equal(committed.status, 200);
  assert.equal(typeof committed.body.card.id, 'number');
  assert.equal(committed.body.card.name, '周叙');
  assert.equal(committed.body.session.state, 'unstarted');
  assert.equal(committed.body.session.state_word, null);
  assert.equal(committed.body.session.token_limit, 500000);

  jsonCardId = committed.body.card.id;
  jsonSessionId = committed.body.session.id;

  const library = await list();
  const found = library.cards.find((item) => item.id === jsonCardId);
  assert.ok(found);
  assert.equal(found.state, 'unstarted');
  assert.equal(found.state_word, null);
  assert.equal(found.today_remaining, 2);
  assert.equal(found.last_message, null);
  assert.equal(found.unread, 0);
  assert.equal(found.avatar_url, null);
  assert.equal(found.compat, 'v2');

  const reused = await commit(previewed.body.token, 'new');
  assert.equal(reused.status, 410);
  assert.equal(reused.body.error.code, 'preview_expired');
});

test('提交 PNG 卡后头像可访问且字节不变', async () => {
  pngCard = makeV2Card({ name: '沈知', description: '总在阳台上修收音机。' });
  pngCardBytes = makePngCard(pngCard);

  const previewed = await preview(pngCardBytes, '沈知.png');
  const committed = await commit(previewed.body.token, 'new');
  assert.equal(committed.status, 200);

  pngCardId = committed.body.card.id;
  pngSessionId = committed.body.session.id;
  assert.equal(committed.body.card.avatar_url, `/api/cards/${pngCardId}/avatar`);

  const avatar = await fetch(`${app.baseUrl}${committed.body.card.avatar_url}`);
  assert.equal(avatar.status, 200);
  assert.match(avatar.headers.get('content-type') ?? '', /image\/png/);
  const avatarBytes = Buffer.from(await avatar.arrayBuffer());
  assert.deepEqual(avatarBytes, pngCardBytes);

  const library = await list();
  const found = library.cards.find((item) => item.id === pngCardId);
  assert.equal(found.avatar_url, `/api/cards/${pngCardId}/avatar`);
});

test('同一张卡再次导入：new 返回 409，overwrite 保留原会话', async () => {
  const before = await list();
  const previewed = await preview(jsonCardBytes, '周叙.json');
  assert.equal(previewed.status, 200);
  assert.equal(previewed.body.duplicate.id, jsonCardId);

  const asNew = await commit(previewed.body.token, 'new');
  assert.equal(asNew.status, 409);
  assert.equal(asNew.body.error.code, 'card_duplicate');

  const overwritten = await commit(previewed.body.token, 'overwrite');
  assert.equal(overwritten.status, 200);
  assert.equal(overwritten.body.card.id, jsonCardId);
  assert.equal(overwritten.body.session.id, jsonSessionId);

  const afterOverwrite = await list();
  assert.equal(afterOverwrite.cards.length, before.cards.length);
});

test('PNG 覆盖导入只更新卡面，头像字节随新图变化', async () => {
  const replacement = makePngCard(pngCard, { pixel: [20, 40, 60, 255] });
  const previewed = await preview(replacement, '沈知.png');
  assert.equal(previewed.body.duplicate.id, pngCardId);

  const overwritten = await commit(previewed.body.token, 'overwrite');
  assert.equal(overwritten.status, 200);
  assert.equal(overwritten.body.card.id, pngCardId);
  assert.equal(overwritten.body.session.id, pngSessionId);

  const avatar = await fetch(`${app.baseUrl}/api/cards/${pngCardId}/avatar`);
  const avatarBytes = Buffer.from(await avatar.arrayBuffer());
  assert.deepEqual(avatarBytes, replacement);
});

test('开始聊天后状态从 unstarted 变成醒着', async () => {
  const started = await startCard(jsonCardId);
  assert.equal(started.status, 200);
  assert.equal(started.body.session.state, 'active');
  assert.equal(started.body.session.state_word, '醒着');
  assert.equal(started.body.session.token_limit, 500000);

  const again = await startCard(jsonCardId);
  assert.equal(again.status, 200);
  assert.equal(again.body.session.state, 'active');

  const library = await list();
  const found = library.cards.find((item) => item.id === jsonCardId);
  assert.equal(found.state, 'active');
  assert.equal(found.state_word, '醒着');
});

test('V1 卡标兼容模式，脚本与世界书给出提示', async () => {
  const v1 = await preview(jsonBytes(makeV1Card()), '顾青.json');
  assert.equal(v1.status, 200);
  assert.equal(v1.body.compat, 'v1');
  assert.equal(v1.body.name, '顾青');

  const scripted = makeV2Card({
    name: '带脚本的卡',
    extensions: { regex_scripts: [{ scriptName: '去掉系统腔' }] },
  });
  const scriptedPreview = await preview(jsonBytes(scripted), '脚本卡.json');
  assert.equal(scriptedPreview.status, 200);
  assert.equal(scriptedPreview.body.has_scripts, true);

  const withBook = makeV2Card({
    name: '带世界书的卡',
    characterBook: {
      name: '城南世界书',
      entries: [{ keys: ['雨'], content: '这座城一年下两百天雨。' }],
    },
  });
  const bookPreview = await preview(jsonBytes(withBook), '世界书卡.json');
  assert.equal(bookPreview.status, 200);
  assert.equal(bookPreview.body.has_book, true);
});

test('角色库支持按名字搜索', async () => {
  const found = await list('周叙');
  assert.equal(found.cards.length, 1);
  assert.equal(found.cards[0].id, jsonCardId);

  const missing = await list('不存在的角色');
  assert.deepEqual(missing.cards, []);
});

test('不支持的扩展名与缺少文件名都返回明确错误', async () => {
  const unsupported = await preview(Buffer.from('hello', 'utf8'), '卡片.txt');
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error.code, 'card_unsupported_type');

  const missingName = await preview(Buffer.from('{}', 'utf8'));
  assert.equal(missingName.status, 400);
  assert.equal(missingName.body.error.code, 'missing_filename');
});
