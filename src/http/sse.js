export function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

export function sendSse(res, event, data) {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function endSse(res) {
  if (!res.writableEnded && !res.destroyed) {
    res.end();
  }
}
