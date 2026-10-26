import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChat } from '../../src/chat/index.js';
import { createStyle } from '../../src/style/index.js';

function characterCard() {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '阿岚',
      description: '住得近，偶尔一起吃饭。',
      personality: '安静，说话短。',
      scenario: '你和她住在同一栋楼。',
      mes_example: '你回来啦。',
    },
  });
}

function makeChat({ budget, summaries = [], facts = [], rows = [] }) {
  const store = {
    sessions: {
      findById: () => ({
        id: 1,
        character_id: 1,
        state: 'active',
        pause_gap_hours: null,
        cold_start_silenced: 0,
      }),
    },
    characters: {
      findById: () => ({ id: 1, card_json: characterCard() }),
    },
    summaries: {
      listRecent: (_sessionId, limit) => summaries.slice(0, limit),
    },
    facts: {
      listPending: (_sessionId, limit) => facts.slice(0, limit),
    },
    messages: {
      listForSession: (_sessionId, { limit }) => rows.slice(0, limit),
    },
  };

  return createChat({
    store,
    clock: { iso: () => '2026-01-01T00:00:00.000Z' },
    config: { llm: { context_budget: budget, chat_timeout_ms: 1000 } },
    llm: {},
    style: createStyle(),
    quota: {},
    bus: { emit() {} },
    log: { warn() {} },
  });
}

function longRound(round) {
  return [
    { id: round * 2 - 1, role: 'user', content: `第${round}轮：${'今天有点累，想早点睡。'.repeat(8)}` },
    { id: round * 2, role: 'char', content: `好，早点休息。第${round}轮。` },
  ];
}

function historyRows(rounds) {
  const rows = [];
  for (let round = 1; round <= rounds; round += 1) {
    rows.push(...longRound(round));
  }
  return rows;
}

function descending(rows) {
  return [...rows].reverse();
}

test('20 轮长对话超预算时丢最旧原文，当前这句话一定保留', () => {
  const rows = descending([
    ...historyRows(19),
    { id: 39, role: 'user', content: '当前这句话：你还醒着吗？' },
  ]);
  const chat = makeChat({ budget: 250, rows });

  const { messages } = chat.buildContext(1, 'chat');
  const contents = messages.map((message) => message.content);

  assert.equal(messages.at(-1).content, '当前这句话：你还醒着吗？');
  assert.ok(contents.some((content) => content.includes('当前这句话')));
  assert.ok(!contents.some((content) => content.includes('第1轮：')));
  assert.ok(messages.length < 40);
});

test('预算再小也不丢摘要；facts 先于摘要被丢', () => {
  const summaries = [
    { id: 1, content: '第一次摘要：她记得你周三面试。' },
    { id: 2, content: '第二次摘要：你们聊过薄荷。' },
  ];
  const facts = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1,
    subject: 'user',
    key: `k${index}`,
    value: `v${index}`,
  }));
  const rows = descending([
    ...historyRows(3),
    { id: 7, role: 'user', content: '当前这句话：在吗？' },
  ]);
  const chat = makeChat({ budget: 100, summaries, facts, rows });

  const { messages } = chat.buildContext(1, 'chat');
  const contents = messages.map((message) => message.content);

  assert.equal(contents.filter((content) => content.includes('【以前的摘要】')).length, 2);
  assert.equal(contents.filter((content) => content.includes('【已知事实】')).length, 0);
  assert.equal(messages.at(-1).content, '当前这句话：在吗？');
});

test('facts 最多只取 5 条', () => {
  const facts = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    subject: 'user',
    key: `k${index}`,
    value: `v${index}`,
  }));
  const rows = descending([
    ...historyRows(1),
    { id: 3, role: 'user', content: '当前这句话：在吗？' },
  ]);
  const chat = makeChat({ budget: 8000, facts, rows });

  const { messages } = chat.buildContext(1, 'chat');

  assert.equal(messages.filter((message) => message.content.includes('【已知事实】')).length, 5);
  assert.equal(messages.at(-1).content, '当前这句话：在吗？');
});
