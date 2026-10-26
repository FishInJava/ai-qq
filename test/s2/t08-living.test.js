import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClock } from '../../src/clock/index.js';
import { createFeeds } from '../../src/living/feeds.js';
import { createLiving } from '../../src/living/index.js';
import { openStore } from '../../src/store/index.js';

const FIXED_MS = Date.parse('2026-10-01T02:00:00.000Z');

function makeStore() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'companion-living-'));
  const clock = createClock({ now: () => FIXED_MS });
  const store = openStore({ dataDir, clock });
  store.migrate();

  function addCharacter() {
    return store.characters.insert({
      name: '阿岚',
      cardJson: JSON.stringify({
        spec: 'chara_card_v2',
        data: {
          name: '阿岚',
          description: '住得近，偶尔一起吃饭。',
          personality: '安静，说话短。',
          scenario: '你和她住在同一栋楼。',
        },
      }),
      extensionsJson: null,
      compat: 'v2',
      avatarPath: null,
      cardSourcePath: null,
      sourceHash: randomUUID(),
      importedAt: clock.iso(),
    });
  }

  const characterId = addCharacter();

  return {
    dataDir,
    clock,
    store,
    characterId,
    addCharacter,
    addSession(state = 'active') {
      return store.sessions.insert({
        characterId: addCharacter(),
        state,
        tokenLimit: 500000,
        createdAt: clock.iso(),
      });
    },
    close() {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function scriptedLlm(script) {
  const calls = [];
  return {
    calls,
    async json({ system, user, schema }) {
      calls.push({ system, user });
      return { value: script(calls.length, { system, user, schema }) };
    },
  };
}

function silentLog() {
  return { warn() {} };
}

test('当日事件生成 2–3 条，重复调用不再问模型', async () => {
  const fixture = makeStore();
  try {
    const { store, clock } = fixture;
    const sessionId = fixture.addSession();
    const llm = scriptedLlm((_call, { system }) => (
      system.includes('一致性')
        ? { conflicts: [] }
        : { events: ['今天把窗台擦了。', '楼下新开了一家面馆。'] }
    ));
    const feeds = { ensureDay: async () => [] };
    const living = createLiving({ store, clock, llm, feeds, log: silentLog() });

    const first = await living.ensureToday(sessionId);
    assert.equal(first.length, 2);
    assert.deepEqual(first.map((row) => row.ordinal), [1, 2]);
    assert.equal(first[0].content, '今天把窗台擦了。');
    assert.equal(first[0].event_date, clock.localDay());
    assert.equal(first[0].used_by_msg_id, null);

    const callsAfterFirst = llm.calls.length;
    const second = await living.ensureToday(sessionId);
    assert.equal(second.length, 2);
    assert.equal(llm.calls.length, callsAfterFirst);

    const page = await living.today(sessionId);
    assert.equal(page.date, clock.localDay());
    assert.equal(page.events.length, 2);
    assert.deepEqual(page.feeds, []);
  } finally {
    fixture.close();
  }
});

test('与角色冲突的事件会重写一次，改不掉就丢掉', async () => {
  const fixture = makeStore();
  try {
    const { store, clock } = fixture;
    const sessionId = fixture.addSession();
    const llm = scriptedLlm((call, { system }) => {
      if (system.includes('一致性')) {
        return call === 2 ? { conflicts: [0, 2] } : { conflicts: [] };
      }
      if (call === 1) {
        return { events: ['今天开了一整天的会。', '把窗台擦了。', '晚上去了健身房。'] };
      }
      return { events: ['晚上煮了一碗面。'] };
    });
    const living = createLiving({
      store,
      clock,
      llm,
      feeds: { ensureDay: async () => [] },
      log: silentLog(),
    });

    const events = await living.ensureToday(sessionId);
    assert.deepEqual(events.map((row) => row.content), ['晚上煮了一碗面。', '把窗台擦了。']);
    assert.equal(events[0].ordinal, 1);
    assert.equal(events[1].ordinal, 2);
  } finally {
    fixture.close();
  }
});

test('模型失败只记日志，不抛给调用方', async () => {
  const fixture = makeStore();
  try {
    const { store, clock } = fixture;
    const sessionId = fixture.addSession();
    const warnings = [];
    const living = createLiving({
      store,
      clock,
      llm: {
        async json() {
          throw Object.assign(new Error('bad json'), { code: 'llm_bad_json' });
        },
      },
      feeds: { ensureDay: async () => [] },
      log: { warn: (name, fields) => warnings.push({ name, fields }) },
    });

    assert.deepEqual(await living.ensureToday(sessionId), []);
    assert.equal(store.lifeEvents.listForDay(sessionId, clock.localDay()).length, 0);
    assert.equal(warnings[0].name, 'living_events_failed');
  } finally {
    fixture.close();
  }
});

test('启动补齐：先抓 feeds，再给已开始的会话补事件；unstarted 跳过', async () => {
  const fixture = makeStore();
  try {
    const { store, clock } = fixture;
    const activeId = fixture.addSession('active');
    const pausedId = fixture.addSession('paused');
    const unstartedId = fixture.addSession('unstarted');
    const day = clock.localDay();
    let feedCalls = 0;

    const feeds = {
      async ensureDay(requested) {
        feedCalls += 1;
        store.worldFeeds.insertIfAbsent({
          date: requested,
          kind: 'holiday',
          content: '今天是国庆节。',
          fetchedAt: clock.iso(),
        });
        return store.worldFeeds.listForDay(requested);
      },
    };
    const llm = scriptedLlm((_call, { system, user }) => {
      if (!system.includes('一致性')) {
        assert.match(user, /国庆节/);
      }
      return system.includes('一致性')
        ? { conflicts: [] }
        : { events: ['在阳台坐了一会儿。', '晚上煮了一碗面。'] };
    });
    const living = createLiving({ store, clock, llm, feeds, log: silentLog() });

    await living.ensureAll();
    assert.equal(feedCalls, 1);
    assert.equal(store.worldFeeds.listForDay(day).length, 1);
    assert.ok(store.lifeEvents.listForDay(activeId, day).length >= 2);
    assert.ok(store.lifeEvents.listForDay(pausedId, day).length >= 2);
    assert.equal(store.lifeEvents.listForDay(unstartedId, day).length, 0);

    const callsAfterFirst = llm.calls.length;
    await living.ensureAll();
    assert.equal(feedCalls, 2);
    assert.equal(store.worldFeeds.listForDay(day).length, 1);
    assert.equal(llm.calls.length, callsAfterFirst);
  } finally {
    fixture.close();
  }
});

function response(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
  };
}

test('feeds：天气 / 节日 / 头条各抓一条，同一天不重复抓', async () => {
  const fixture = makeStore();
  try {
    const { store, clock } = fixture;
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (url.includes('api.open-meteo.com/v1/forecast')) {
        return response(JSON.stringify({
          current: { temperature_2m: 18.4, weather_code: 2 },
        }));
      }
      if (url.includes('rss.sina.com.cn')) {
        return response([
          '<rss><channel><item>',
          '<title><![CDATA[某地大桥今日通车]]></title>',
          '<description>首段通车，方便了不少人。后面还有更多内容。</description>',
          '</item></channel></rss>',
        ].join(''));
      }
      throw new Error(`unexpected url ${url}`);
    };
    const feeds = createFeeds({
      store,
      clock,
      config: { living: { city: '上海' } },
      log: silentLog(),
      fetchImpl,
    });

    const rows = await feeds.ensureDay('2026-10-01');
    assert.deepEqual(rows.map((row) => row.kind), ['weather', 'holiday', 'news']);
    assert.match(rows[0].content, /上海今天 18°C，多云。/);
    assert.equal(rows[1].content, '今天是国庆节。');
    assert.match(rows[2].content, /^头条：某地大桥今日通车。/);
    assert.match(rows[2].content, /首段通车/);

    const callsAfterFirst = urls.length;
    const again = await feeds.ensureDay('2026-10-01');
    assert.equal(again.length, 3);
    assert.equal(urls.length, callsAfterFirst);
  } finally {
    fixture.close();
  }
});

test('feeds：单类失败不拖垮其他类别', async () => {
  const fixture = makeStore();
  try {
    const { store, clock } = fixture;
    const fetchImpl = async (url) => {
      if (url.includes('api.open-meteo.com')) {
        throw new Error('network down');
      }
      if (url.includes('rss.sina.com.cn')) {
        return response('<rss><channel><item><title>一条头条</title><description>第一句。</description></item></channel></rss>');
      }
      throw new Error(`unexpected url ${url}`);
    };
    const warnings = [];
    const feeds = createFeeds({
      store,
      clock,
      config: { living: { city: '上海' } },
      log: { warn: (name) => warnings.push(name) },
      fetchImpl,
    });

    const rows = await feeds.ensureDay('2026-10-01');
    assert.deepEqual(rows.map((row) => row.kind), ['holiday', 'news']);
    assert.equal(warnings[0], 'living_feed_failed');
  } finally {
    fixture.close();
  }
});
