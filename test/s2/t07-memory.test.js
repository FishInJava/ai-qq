import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { systemClock } from '../../src/clock/index.js';
import { createMemory } from '../../src/memory/index.js';
import { openStore } from '../../src/store/index.js';

function makeStore() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'companion-memory-'));
  const store = openStore({ dataDir, clock: systemClock });
  store.migrate();

  const characterId = store.characters.insert({
    name: '阿岚',
    cardJson: '{"spec":"chara_card_v2","data":{"name":"阿岚"}}',
    extensionsJson: null,
    compat: 'v2',
    avatarPath: null,
    cardSourcePath: null,
    sourceHash: randomUUID(),
    importedAt: systemClock.iso(),
  });
  const sessionId = store.sessions.insert({
    characterId,
    state: 'active',
    tokenLimit: 500000,
    createdAt: systemClock.iso(),
  });

  return {
    dataDir,
    store,
    sessionId,
    close() {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function addMessage(store, sessionId, role, content) {
  return store.messages.insert({
    sessionId,
    role,
    content,
    createdAt: systemClock.iso(),
  });
}

function fakeLlm() {
  let extractCalls = 0;
  return {
    async json({ schema }) {
      if ((schema.required ?? []).includes('summary')) {
        return { value: { summary: '用户住在杭州，周三还有一场面试，最近有点累。' } };
      }
      extractCalls += 1;
      return {
        value: {
          found: true,
          facts: [{
            subject: 'user',
            key: 'city',
            value: extractCalls === 1 ? '杭州' : '上海',
          }],
        },
      };
    },
  };
}

test('事实抽取会保留旧版本，检索能命中过期事实', async () => {
  const fixture = makeStore();
  try {
    const { store, sessionId } = fixture;
    const memory = createMemory({
      store,
      clock: systemClock,
      llm: fakeLlm(),
      log: { warn() {} },
    });

    const firstMessage = addMessage(store, sessionId, 'user', '我住在杭州。');
    const first = await memory.extract(sessionId, [firstMessage]);
    assert.equal(first.length, 1);
    assert.equal(first[0].key, 'city');
    assert.equal(first[0].value, '杭州');

    let current = store.facts.findActive(sessionId, 'user', 'city');
    assert.equal(current.value, '杭州');
    assert.equal(current.valid_to, null);

    const secondMessage = addMessage(store, sessionId, 'user', '我搬到上海了。');
    const second = await memory.extract(sessionId, [secondMessage]);
    assert.equal(second[0].value, '上海');

    const all = store.facts.listAll(sessionId);
    assert.equal(all.length, 2);
    assert.equal(all.filter((row) => row.valid_to === null).length, 1);
    current = store.facts.findActive(sessionId, 'user', 'city');
    assert.equal(current.value, '上海');

    const hit = memory.search(sessionId, '杭州');
    assert.equal(hit.facts.length, 1);
    assert.equal(hit.facts[0].value, '杭州');
    assert.notEqual(hit.facts[0].valid_to, null);

    const listed = memory.list(sessionId);
    assert.equal(listed.facts.length, 2);

    assert.equal(memory.removeFact(current.id), true);
    assert.equal(memory.list(sessionId).facts.length, 1);
    assert.equal(memory.removeFact(current.id), false);
  } finally {
    fixture.close();
  }
});

test('20 个用户轮次生成一条摘要，之后不足 20 轮不再生成', async () => {
  const fixture = makeStore();
  try {
    const { store, sessionId } = fixture;
    const memory = createMemory({
      store,
      clock: systemClock,
      llm: fakeLlm(),
      log: { warn() {} },
    });

    for (let round = 1; round <= 20; round += 1) {
      addMessage(store, sessionId, 'user', `第${round}轮：今天还好吗？`);
      addMessage(store, sessionId, 'char', `第${round}轮：嗯，我在。`);
    }

    const summary = await memory.summarize(sessionId);
    assert.ok(summary);
    assert.ok(summary.content.length <= 300);
    assert.equal(summary.from_msg_id, 1);
    assert.equal(summary.to_msg_id, 40);

    const rows = memory.list(sessionId).summaries;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].from_msg_id, 1);
    assert.equal(rows[0].to_msg_id, 40);

    assert.equal(await memory.summarize(sessionId), null);

    addMessage(store, sessionId, 'user', '第21轮：还在吗？');
    assert.equal(await memory.summarize(sessionId), null);

    const hit = memory.search(sessionId, '面试');
    assert.equal(hit.summaries.length, 1);
  } finally {
    fixture.close();
  }
});

test('抽取失败只返回 null，不抛给对话', async () => {
  const fixture = makeStore();
  try {
    const { store, sessionId } = fixture;
    const memory = createMemory({
      store,
      clock: systemClock,
      llm: {
        async json() {
          throw Object.assign(new Error('bad json'), { code: 'llm_bad_json' });
        },
      },
      log: { warn() {} },
    });

    const messageId = addMessage(store, sessionId, 'user', '我住在杭州。');
    assert.equal(await memory.extract(sessionId, [messageId]), null);
    assert.equal(store.facts.listAll(sessionId).length, 0);
  } finally {
    fixture.close();
  }
});
