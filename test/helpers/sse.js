/**
 * 把一段 SSE 文本帧解析成 `{ event, data }`；注释帧返回 null。
 *
 * @param {string} frame
 */
export function parseSseFrame(frame) {
  let event = 'message';
  const dataLines = [];

  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const raw = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: raw };
  }
}

/**
 * 逐帧读取 SSE，直到 `until` 命中或流结束；传 `signal` 时可在外部中止。
 *
 * @param {Response} response
 * @param {{ until?: (event: { event: string, data: any }) => boolean, signal?: AbortSignal }} [options]
 */
export async function readSseEvents(response, { until = null, signal = null } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });

      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);

        const event = parseSseFrame(frame);
        if (event) {
          events.push(event);
          if (until && until(event)) {
            return events;
          }
        }

        boundary = /\r?\n\r?\n/.exec(buffer);
      }
    }
    return events;
  } catch (err) {
    if (signal?.aborted) {
      return events;
    }
    throw err;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 流已经关闭或被中止。
    }
  }
}
