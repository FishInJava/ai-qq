import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { systemClock } from '../../src/clock/index.js';
import { createLlm } from '../../src/llm/index.js';
import { DEFAULT_CONFIG } from '../../src/runtime/config.js';
import { startFakeLlm } from '../helpers/fake-llm.js';

const silentLog = {
  info() {},
  warn() {},
  error() {},
};

let fake;

before(async () => {
  fake = await startFakeLlm();
});

after(async () => {
  await fake?.stop();
});

function llmFor(model, overrides = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.llm, {
    base_url: fake.baseUrl,
    api_key: 'test-key',
    chat_model: model,
    utility_model: model,
    ...overrides,
  });
  return createLlm({
    config,
    clock: systemClock,
    log: silentLog,
    retryDelaysMs: [0, 0],
  });
}

const messages = [{ role: 'user', content: '在吗？' }];

test('正常流式回复能逐段读出来，并带 usage', async () => {
  const llm = llmFor('fake-ok');
  const events = [];

  for await (const event of llm.chatStream({ messages, timeoutMs: 2000 })) {
    events.push(event);
  }

  const text = events
    .filter((event) => typeof event.delta === 'string')
    .map((event) => event.delta)
    .join('');
  assert.equal(text, '嗯，我在。');

  const usageEvent = events.find((event) => Object.hasOwn(event, 'usage'));
  assert.deepEqual(usageEvent.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });
  assert.deepEqual(events.at(-1), { done: true });
});

test('上游没给 usage 时如实返回 null，不伪造', async () => {
  const llm = llmFor('fake-no-usage');
  const events = [];

  for await (const event of llm.chatStream({ messages, timeoutMs: 2000 })) {
    events.push(event);
  }

  const usageEvent = events.find((event) => Object.hasOwn(event, 'usage'));
  assert.equal(usageEvent.usage, null);
  assert.deepEqual(events.at(-1), { done: true });
});

test('连续两次 5xx 会退避重试，第三次成功', async () => {
  const llm = llmFor('fake-flaky');

  const result = await llm.chatOnce({ messages, timeoutMs: 2000 });

  assert.equal(result.text, '嗯，我在。');
  assert.deepEqual(result.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });

  const stats = await fake.stats();
  assert.equal(stats.counts.flaky, 3);
});

test('5xx 重试两次后仍失败，抛不可重试的 llm_unavailable', async () => {
  const llm = llmFor('fake-5xx');

  await assert.rejects(
    () => llm.chatOnce({ messages, timeoutMs: 2000 }),
    (err) => err.code === 'llm_unavailable' && err.retryable === false,
  );

  const stats = await fake.stats();
  assert.equal(stats.counts['5xx'], 3);
});

test('401 鉴权失败不重试，抛 config_invalid', async () => {
  const llm = llmFor('fake-auth');

  await assert.rejects(
    () => llm.chatOnce({ messages, timeoutMs: 2000 }),
    (err) => err.code === 'config_invalid',
  );

  const stats = await fake.stats();
  assert.equal(stats.counts.auth, 1);
});

test('上游挂起时按超时中断，抛 llm_timeout', async () => {
  const llm = llmFor('fake-timeout');

  await assert.rejects(
    () => llm.chatOnce({ messages, timeoutMs: 150 }),
    (err) => err.code === 'llm_timeout',
  );
});

test('流式读到一半挂起也会按超时中断', async () => {
  const llm = llmFor('fake-timeout');

  await assert.rejects(async () => {
    for await (const event of llm.chatStream({ messages, timeoutMs: 150 })) {
      void event;
    }
  }, (err) => err.code === 'llm_timeout');
});

test('端点连不上时抛 llm_unavailable，不重试', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.llm, {
    base_url: 'http://127.0.0.1:1/v1',
    api_key: 'test-key',
    chat_model: 'fake-ok',
    utility_model: 'fake-ok',
  });
  const llm = createLlm({
    config,
    clock: systemClock,
    log: silentLog,
    retryDelaysMs: [0, 0],
  });

  await assert.rejects(
    () => llm.chatOnce({ messages, timeoutMs: 2000 }),
    (err) => err.code === 'llm_unavailable' && err.retryable === false,
  );
});

test('json() 解析并按 schema 校验，坏格式抛 llm_bad_json', async () => {
  const schema = {
    type: 'object',
    required: ['found', 'facts'],
    properties: {
      found: { type: 'boolean' },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['subject', 'key', 'value'],
          properties: {
            subject: { type: 'string', enum: ['user', 'char', 'world'] },
            key: { type: 'string' },
            value: { type: 'string' },
          },
        },
      },
    },
  };

  const ok = await llmFor('fake-json-ok').json({
    system: '只输出 JSON。',
    user: '抽一条事实。',
    schema,
    timeoutMs: 2000,
  });
  assert.equal(ok.value.found, true);
  assert.equal(ok.value.facts[0].value, '杭州');

  await assert.rejects(
    () => llmFor('fake-json-invalid').json({
      system: '只输出 JSON。',
      user: '抽一条事实。',
      schema,
      timeoutMs: 2000,
    }),
    (err) => err.code === 'llm_bad_json',
  );

  await assert.rejects(
    () => llmFor('fake-bad-json').json({
      system: '只输出 JSON。',
      user: '抽一条事实。',
      schema,
      timeoutMs: 2000,
    }),
    (err) => err.code === 'llm_bad_json',
  );
});

test('没配地址或模型时抛 llm_not_configured', async () => {
  const noBaseUrl = structuredClone(DEFAULT_CONFIG);
  noBaseUrl.llm.chat_model = 'fake-ok';
  noBaseUrl.llm.utility_model = 'fake-ok';

  await assert.rejects(
    () => createLlm({ config: noBaseUrl, clock: systemClock, log: silentLog })
      .chatOnce({ messages, timeoutMs: 1000 }),
    (err) => err.code === 'llm_not_configured',
  );

  const noModel = structuredClone(DEFAULT_CONFIG);
  noModel.llm.base_url = fake.baseUrl;

  await assert.rejects(
    () => createLlm({ config: noModel, clock: systemClock, log: silentLog })
      .chatOnce({ messages, timeoutMs: 1000 }),
    (err) => err.code === 'llm_not_configured',
  );
});
