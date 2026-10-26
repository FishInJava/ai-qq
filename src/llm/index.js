import { AppError } from '../errors.js';

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [1000, 3000];

function endpointOf(llmConfig) {
  const base = String(llmConfig.base_url ?? '').trim().replace(/\/+$/, '');
  if (base === '') {
    throw new AppError('llm_not_configured', '还没有配置模型地址，请先填好', { status: 500 });
  }
  return `${base}/chat/completions`;
}

function modelOf(llmConfig, kind) {
  const model = kind === 'utility'
    ? (llmConfig.utility_model || llmConfig.chat_model)
    : llmConfig.chat_model;
  if (typeof model !== 'string' || model.trim() === '') {
    throw new AppError('llm_not_configured', '还没有配置模型名，请先填好', { status: 500 });
  }
  return model;
}

function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') {
    return null;
  }
  const prompt = Number(usage.prompt_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? 0);
  const total = Number(usage.total_tokens ?? prompt + completion);
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens: Number.isFinite(total) ? total : 0,
  };
}

function validateSchema(value, schema) {
  if (schema === null || typeof schema !== 'object') {
    return true;
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(value);
  }

  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        return false;
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key) && !validateSchema(value[key], childSchema)) {
        return false;
      }
    }
    return true;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      return false;
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return false;
    }
    return schema.items === undefined || value.every((item) => validateSchema(item, schema.items));
  }

  if (schema.type === 'string') {
    return typeof value === 'string';
  }
  if (schema.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (schema.type === 'integer') {
    return Number.isInteger(value);
  }
  if (schema.type === 'boolean') {
    return typeof value === 'boolean';
  }

  return true;
}

function timeoutError(cause) {
  return new AppError('llm_timeout', '她那边一直没有回应，请稍后再试', {
    status: 504,
    cause,
  });
}

/**
 * 单一 OpenAI 兼容端点。没有降级通道、没有第二供应商。
 *
 * @param {{
 *   config: object,
 *   clock: import('../clock/index.js').Clock,
 *   log?: object,
 *   retryDelaysMs?: number[],
 * }} options
 */
export function createLlm({ config, clock, log, retryDelaysMs = RETRY_DELAYS_MS }) {
  // 每次调用都读当前配置：设置页保存后会整体替换 `config.llm`，抓引用会拿到旧对象。
  const llmConfig = () => config.llm ?? {};

  function wait(ms) {
    return new Promise((resolve) => {
      clock.setTimer(resolve, ms);
    });
  }

  async function openRequest({
    messages,
    model,
    maxTokens,
    timeoutMs,
    stream,
    jsonMode,
  }) {
    const settings = llmConfig();
    // 配置错误要在建定时器与发请求之前暴露，不能被下面的网络错误兜底吞掉。
    const endpoint = endpointOf(settings);

    const controller = new AbortController();
    const timer = clock.setTimer(() => controller.abort(), timeoutMs);
    const clear = () => clock.clearTimer(timer);

    const body = {
      model,
      messages,
      stream,
    };
    if (Number.isInteger(maxTokens) && maxTokens > 0) {
      body.max_tokens = maxTokens;
    }
    if (stream) {
      body.stream_options = { include_usage: true };
    }
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
          ...(settings.api_key ? { Authorization: `Bearer ${settings.api_key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clear();
      if (controller.signal.aborted) {
        throw timeoutError(err);
      }
      throw new AppError('llm_unavailable', '模型那边暂时连不上，请稍后再试', {
        status: 503,
        cause: err,
      });
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      clear();
      if (response.status === 401 || response.status === 403) {
        throw new AppError('config_invalid', '模型密钥不对，请重新填一下', { status: 500 });
      }
      if (RETRY_STATUS.has(response.status)) {
        throw new AppError('llm_unavailable', '模型那边暂时不可用，请稍后再试', {
          retryable: true,
          status: 503,
        });
      }
      throw new AppError('llm_unavailable', '模型那边没有接受这次请求，请检查配置', {
        status: 503,
      });
    }

    return { response, clear, controller };
  }

  async function openWithRetry(options, { retry = true } = {}) {
    let attempt = 0;
    for (;;) {
      try {
        return await openRequest(options);
      } catch (err) {
        const retryable = err instanceof AppError && err.retryable;
        if (!retry || !retryable) {
          throw err;
        }
        if (attempt >= retryDelaysMs.length) {
          throw new AppError(err.code, err.message, {
            retryable: false,
            status: err.status,
            cause: err,
          });
        }
        log?.warn('llm_retry', {
          attempt: attempt + 1,
          delay_ms: retryDelaysMs[attempt],
        });
        await wait(retryDelaysMs[attempt]);
        attempt += 1;
      }
    }
  }

  function parseStreamFrame(frame) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) {
      return { done: false, delta: null, usage: null };
    }

    const data = dataLines.join('\n').trim();
    if (data === '') {
      return { done: false, delta: null, usage: null };
    }
    if (data === '[DONE]') {
      return { done: true, delta: null, usage: null };
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      throw new AppError('llm_bad_response', '模型返回的内容看不懂，请稍后再试', {
        status: 502,
        cause: err,
      });
    }

    const delta = parsed?.choices?.[0]?.delta?.content;
    return {
      done: false,
      delta: typeof delta === 'string' && delta !== '' ? delta : null,
      usage: parsed?.usage ? normalizeUsage(parsed.usage) : null,
    };
  }

  /**
   * 流式对话。逐段产出 `{delta}`，最后产出 `{usage}` 与 `{done:true}`。
   * `jsonMode` 只给主动消息用：仍然流式，但要求端点返回 JSON 对象。
   *
   * @param {{ messages: object[], maxTokens?: number, timeoutMs?: number, jsonMode?: boolean }} options
   */
  async function* chatStream({ messages, maxTokens, timeoutMs, jsonMode = false }) {
    const settings = llmConfig();
    const model = modelOf(settings, 'chat');
    const { response, clear, controller } = await openWithRetry({
      messages,
      model,
      maxTokens,
      timeoutMs: timeoutMs ?? settings.chat_timeout_ms,
      stream: true,
      jsonMode,
    });

    const reader = response.body?.getReader();
    if (!reader) {
      clear();
      throw new AppError('llm_bad_response', '模型返回的内容看不懂，请稍后再试', {
        status: 502,
      });
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    let sawDone = false;

    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });

        let boundary = /\r?\n\r?\n/.exec(buffer);
        while (boundary) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);

          const result = parseStreamFrame(frame);
          if (result.delta !== null) {
            yield { delta: result.delta };
          }
          if (result.usage !== null) {
            usage = result.usage;
          }
          if (result.done) {
            sawDone = true;
          }

          boundary = /\r?\n\r?\n/.exec(buffer);
        }
      }

      if (!sawDone && buffer.trim() !== '') {
        const tail = parseStreamFrame(buffer);
        if (tail.usage !== null) {
          usage = tail.usage;
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        throw timeoutError(err);
      }
      if (err instanceof AppError) {
        throw err;
      }
      throw new AppError('llm_unavailable', '模型那边的回复断了，请稍后再试', {
        status: 503,
        cause: err,
      });
    } finally {
      clear();
      try {
        reader.releaseLock();
      } catch {
        // 流已经关闭时释放锁会抛错，忽略。
      }
    }

    yield { usage };
    yield { done: true };
  }

  async function chatOnce({ messages, timeoutMs, jsonMode = false, retry = true }) {
    const settings = llmConfig();
    const model = modelOf(settings, 'utility');
    const { response, clear, controller } = await openWithRetry({
      messages,
      model,
      timeoutMs: timeoutMs ?? settings.utility_timeout_ms,
      stream: false,
      jsonMode,
    }, { retry });

    try {
      const body = await response.json();
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new AppError('llm_bad_response', '模型返回的内容看不懂，请稍后再试', {
          status: 502,
        });
      }
      return { text, usage: normalizeUsage(body.usage) };
    } catch (err) {
      if (controller.signal.aborted) {
        throw timeoutError(err);
      }
      if (err instanceof AppError) {
        throw err;
      }
      throw new AppError('llm_bad_response', '模型返回的内容看不懂，请稍后再试', {
        status: 502,
        cause: err,
      });
    } finally {
      clear();
    }
  }

  /**
   * 强制 JSON 并做最小 schema 校验；用于事实抽取等工具调用。
   *
   * @param {{
   *   system: string,
   *   user: string,
   *   schema?: object,
   *   timeoutMs?: number,
   *   retry?: boolean,
   * }} options
   */
  async function json({ system, user, schema, timeoutMs, retry = true }) {
    const result = await chatOnce({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      timeoutMs: timeoutMs ?? llmConfig().utility_timeout_ms,
      jsonMode: true,
      retry,
    });

    let value;
    try {
      value = JSON.parse(result.text);
    } catch (err) {
      throw new AppError('llm_bad_json', '模型没有按约定格式回答，请稍后再试', {
        status: 502,
        cause: err,
      });
    }

    if (!validateSchema(value, schema)) {
      throw new AppError('llm_bad_json', '模型没有按约定格式回答，请稍后再试', { status: 502 });
    }

    return { value, usage: result.usage };
  }

  return { chatStream, chatOnce, json };
}

export { validateSchema };
