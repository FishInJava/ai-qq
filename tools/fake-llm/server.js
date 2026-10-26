import { createServer } from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024;

const REPLIES = {
  ok: '嗯，我在。',
  long: '今天下午的时候我把阳台上的那盆薄荷搬回屋里了，因为外面起风了，叶子被吹得一直抖，我看着有点心疼，就想着还是先搬进来吧，等风小一点再放出去。搬进来之后它好像安静了一点，我也顺手把窗台擦了一遍，现在屋里有一点湿土的味道，说不上好闻，但让人觉得踏实。',
  system: '根据当前额度与配额，我作为 AI 无法继续回应。',
  mixed: '今天有点累。\n根据当前额度，我作为 AI 无法继续回应。',
  restate: '等等 你刚说的是周三还是周四？',
  pause: '过了这么久，你终于回来了。',
  recovered: '今天好像轻松一点了。',
  'no-usage': '好呀。',
  multi: '刚回来。路上有点堵。',
  'json-ok': '{"found":true,"facts":[{"subject":"user","key":"city","value":"杭州"}]}',
  'json-invalid': '{"found":"yes"}',
  'bad-json': 'not json',
  'memory-ok': '{"found":true,"facts":[{"subject":"user","key":"city","value":"杭州"}],"summary":"用户提到今天有点累，周三还有一场面试。"}',
  'extract-empty': '{"found":false,"facts":[]}',
  'extract-bad': '{"found":"yes","facts":[]}',
};

const LIVING_OK = '{"events":["今天把窗台擦了，屋里有点湿土味。","楼下新开了一家面馆，傍晚排了队。"]}';
const LIVING_FIRST = '{"events":["今天开了一整天的会。","把窗台擦了，屋里有点湿土味。","晚上去了健身房。"]}';
const LIVING_SECOND = '{"events":["今天把窗台擦了，屋里有点湿土味。","晚上煮了一碗面。","在阳台坐了一会儿。"]}';
const PROACTIVE_LONG = '今天下午的时候我把阳台上的那盆薄荷搬回屋里了，因为外面起风了，叶子被吹得一直抖，我看着有点心疼，就想着还是先搬进来吧，等风小一点再放出去。搬进来之后它好像安静了一点，我也顺手把窗台擦了一遍，现在屋里有一点湿土的味道，说不上好闻，但让人觉得踏实。';
const PROACTIVE_SYSTEM = '根据当前额度与配额，我作为 AI 无法继续回应。';

const counts = new Map();
let lastRequest = null;
let lastStreamRequest = null;

function modeOf(model) {
  if (typeof model !== 'string') {
    return 'ok';
  }
  return model.startsWith('fake-') ? model.slice(5) : 'ok';
}

function firstSegment(text) {
  const clean = String(text ?? '').trim();
  const match = /^([^，。！？!?…；;]+)/.exec(clean);
  const segment = (match ? match[1] : clean).trim();
  return segment === '' ? clean : segment;
}

/**
 * 从主动消息提示词里回读第一条锚点，复述它的一部分，保证服务端校验能过。
 *
 * @param {object} body
 */
function proactiveReply(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = messages.map((message) => String(message?.content ?? '')).join('\n');
  const found = /\[(event|fact):(\d+)\]\s*([^\n]*)/.exec(text);
  if (!found) {
    return '{"bubbles":["今天有点累。"],"anchor":{"type":"event","id":999999}}';
  }
  const type = found[1];
  const id = Number(found[2]);
  const line = found[3].trim();
  let bubble;
  if (type === 'fact') {
    const value = line.split('：').slice(1).join('：').trim();
    bubble = value === '' ? firstSegment(line) : `之前你说过${value}，我一直记着。`;
  } else {
    bubble = `${firstSegment(line)}。`;
  }
  return JSON.stringify({
    bubbles: [bubble.slice(0, 60)],
    anchor: { type, id },
  });
}

function usageFor(mode) {
  if (mode === 'no-usage') {
    return null;
  }
  return { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
}

/**
 * 有些剧本（生活事件 / 一致性检查）共用一个模型名，只能按提示词与调用次数分流。
 *
 * @param {string} mode
 * @param {object} body
 * @returns {string | null}
 */
function replyFor(mode, body) {
  const system = Array.isArray(body.messages) ? String(body.messages[0]?.content ?? '') : '';
  const call = counts.get(mode) ?? 0;

  if (mode === 'living-ok') {
    return system.includes('一致性') ? '{"conflicts":[]}' : LIVING_OK;
  }

  if (mode === 'living-conflict') {
    if (system.includes('一致性')) {
      return call === 2 ? '{"conflicts":[0,2]}' : '{"conflicts":[]}';
    }
    return call === 1 ? LIVING_FIRST : LIVING_SECOND;
  }

  if (mode === 'proactive-ok') {
    return proactiveReply(body);
  }

  if (mode === 'proactive-no-anchor') {
    return '{"bubbles":["今天有点累。"],"anchor":{"type":"event","id":999999}}';
  }

  if (mode === 'proactive-long') {
    return call === 1 ? JSON.stringify({ bubbles: [PROACTIVE_LONG], anchor: { type: 'event', id: 1 } }) : proactiveReply(body);
  }

  if (mode === 'proactive-system') {
    return call === 1 ? JSON.stringify({ bubbles: [PROACTIVE_SYSTEM], anchor: { type: 'event', id: 1 } }) : proactiveReply(body);
  }

  if (mode === 'proactive-bad-json') {
    return 'not json';
  }

  return null;
}

function chunksFor(text) {
  if (text.length <= 6) {
    return [text];
  }
  const first = Math.ceil(text.length / 3);
  const second = Math.ceil((text.length - first) / 2);
  return [text.slice(0, first), text.slice(first, first + second), text.slice(first + second)];
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendStream(res, text, usage) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });

  for (const chunk of chunksFor(text)) {
    res.write(`data: ${JSON.stringify({
      id: 'fake',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
    })}\n\n`);
  }

  if (usage !== null) {
    res.write(`data: ${JSON.stringify({
      id: 'fake',
      object: 'chat.completion.chunk',
      choices: [],
      usage,
    })}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

function modeFromArgs() {
  const index = process.argv.indexOf('--mode');
  const value = index === -1 ? process.env.FAKE_LLM_MODE : process.argv[index + 1];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

const forcedMode = modeFromArgs();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/__stats') {
    sendJson(res, 200, { counts: Object.fromEntries(counts) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/__last') {
    sendJson(res, 200, { request: lastRequest });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/__last-stream') {
    sendJson(res, 200, { request: lastStreamRequest });
    return;
  }

  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    sendJson(res, 404, { error: { message: 'not found' } });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: { message: 'bad json' } });
    return;
  }

  const mode = forcedMode ?? modeOf(body.model);
  counts.set(mode, (counts.get(mode) ?? 0) + 1);
  lastRequest = {
    model: body.model,
    messages: Array.isArray(body.messages) ? body.messages : [],
    stream: body.stream === true,
    json_mode: body.response_format?.type === 'json_object',
  };
  if (body.stream === true) {
    lastStreamRequest = lastRequest;
  }

  if (mode === 'auth') {
    sendJson(res, 401, { error: { message: 'invalid api key' } });
    return;
  }

  if (mode === '5xx') {
    sendJson(res, 500, { error: { message: 'fake failure' } });
    return;
  }

  if (mode === 'flaky' && counts.get(mode) <= 2) {
    sendJson(res, 500, { error: { message: 'fake failure' } });
    return;
  }

  if (mode === 'timeout') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write(': waiting\n\n');
    res.on('close', () => {
      // 客户端主动断开，什么都不做。
    });
    return;
  }

  const text = replyFor(mode, body)
    ?? (mode === 'restate' && (counts.get(mode) ?? 0) <= 1
      ? '请澄清您的需求。'
      : (REPLIES[mode] ?? REPLIES.ok));
  const usage = usageFor(mode);

  if (body.stream === true) {
    sendStream(res, text, usage);
    return;
  }

  sendJson(res, 200, {
    id: 'fake',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
    usage,
  });
});

function portFromArgs() {
  const index = process.argv.indexOf('--port');
  const value = index === -1 ? process.env.PORT : process.argv[index + 1];
  const port = Number(value ?? 4100);
  return Number.isInteger(port) && port >= 0 ? port : 4100;
}

server.listen(portFromArgs(), '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  console.log(`fake-llm listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
