/**
 * 极简 SSE 输出。帧格式固定为 `event: <name>\ndata: <json>\n\n`。
 *
 * @param {import('node:http').ServerResponse} res
 */
export function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} event
 * @param {unknown} data
 */
export function sendSse(res, event, data) {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * @param {import('node:http').ServerResponse} res
 */
export function endSse(res) {
  if (!res.writableEnded && !res.destroyed) {
    res.end();
  }
}
