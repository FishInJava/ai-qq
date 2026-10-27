import { AppError } from '../errors.js';

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

export function sendError(res, err, fallbackStatus = 500) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = err instanceof AppError ? err.status : fallbackStatus;
  const code = err instanceof AppError ? err.code : 'internal';
  const message = err instanceof AppError ? err.message : '服务出了点问题，请稍后再试';
  sendJson(res, status, { error: { code, message } });
}

export function readBody(req, limit, message = '内容太大，请选择小一点的文件') {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new AppError('payload_too_large', message, { status: 413 }));
      return;
    }

    const chunks = [];
    let size = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      if (rejected) {
        return;
      }
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        chunks.length = 0;
        reject(new AppError('payload_too_large', message, { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks));
      }
    });

    req.on('error', (err) => {
      if (!rejected) {
        rejected = true;
        reject(err);
      }
    });

    req.on('aborted', () => {
      if (!rejected) {
        rejected = true;
        reject(new AppError('request_aborted', '请求中断了', { status: 400 }));
      }
    });
  });
}

export async function readJson(req, limit = 64 * 1024) {
  const body = await readBody(req, limit, '请求内容太大');
  if (body.length === 0) {
    throw new AppError('invalid_json', '请求内容不是有效的 JSON', { status: 400 });
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (err) {
    throw new AppError('invalid_json', '请求内容不是有效的 JSON', { status: 400, cause: err });
  }
}

export function sendBuffer(res, status, buffer, contentType, headers = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(buffer);
}
