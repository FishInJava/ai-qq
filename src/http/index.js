import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../errors.js';
import { sendError, sendJson } from './respond.js';
import { createRouter } from './router.js';
import { registerCardRoutes } from './routes/cards.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerEventRoutes } from './routes/events.js';
import { registerLivingRoutes } from './routes/living.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerScheduleRoutes } from './routes/schedule.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerUsageRoutes } from './routes/usage.js';

const WEB_ROOT = path.resolve(fileURLToPath(new URL('../../web/', import.meta.url)));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function safeStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, '');
  if (relative === '' || relative.includes('\0')) {
    return null;
  }
  const candidate = path.resolve(WEB_ROOT, relative);
  if (candidate !== WEB_ROOT && !candidate.startsWith(`${WEB_ROOT}${path.sep}`)) {
    return null;
  }
  return candidate;
}

/**
 * 本地 HTTP 服务。只绑 127.0.0.1，校验 Host，页面与 API 共用同一个端口。
 *
 * @param {{
 *   config: object,
 *   clock: import('../clock/index.js').Clock,
 *   log: object,
 *   bus: object,
 *   version: string,
 *   startedAt: number,
 *   cards: object,
 *   library: object,
 *   session: object,
 *   chat: object,
 *   memory: object,
 *   living: object,
 *   schedule: object,
 *   quota: object,
 *   configService: object,
 *   admin: object,
 * }} options
 */
export function createHttp({
  config,
  clock,
  log,
  bus,
  version,
  startedAt,
  cards,
  library,
  session,
  chat,
  memory,
  living,
  schedule,
  quota,
  configService,
  admin,
}) {
  let actualPort = 0;
  let listening = false;

  const router = createRouter();
  registerCardRoutes(router, { cards, library, session });
  registerSessionRoutes(router, { session });
  registerMessageRoutes(router, { chat, log });
  registerMemoryRoutes(router, { memory });
  registerLivingRoutes(router, { living });
  registerScheduleRoutes(router, { schedule, config });
  registerEventRoutes(router, { bus });
  if (quota) {
    registerUsageRoutes(router, { quota });
  }
  if (configService) {
    registerConfigRoutes(router, { configService });
  }
  if (admin) {
    registerAdminRoutes(router, { admin });
  }

  const hostAllowed = (hostHeader) => {
    if (!hostHeader) {
      return false;
    }
    const allowed = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
    if (actualPort === 80) {
      allowed.add('127.0.0.1');
      allowed.add('localhost');
    }
    return allowed.has(hostHeader.toLowerCase());
  };

  const originAllowed = (origin, hostHeader) => {
    if (origin === undefined) {
      return true;
    }
    if (typeof origin !== 'string' || origin === '') {
      return false;
    }
    try {
      const parsed = new URL(origin);
      return parsed.protocol === 'http:'
        && parsed.host.toLowerCase() === String(hostHeader).toLowerCase();
    } catch {
      return false;
    }
  };

  async function serveFile(res, filePath, method) {
    let info;
    try {
      info = await stat(filePath);
    } catch {
      sendError(res, new AppError('not_found', '没有找到这个页面', { status: 404 }));
      return;
    }
    if (!info.isFile()) {
      sendError(res, new AppError('not_found', '没有找到这个页面', { status: 404 }));
      return;
    }
    const body = await readFile(filePath);
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
  }

  async function handle(req, res) {
    try {
      if (!hostAllowed(req.headers.host)) {
        sendError(res, new AppError('forbidden_host', '只接受本机访问', { status: 403 }));
        return;
      }

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          version,
          uptime_ms: Math.max(0, clock.now() - startedAt),
          port: actualPort,
          today: clock.localDay(),
          yesterday: clock.localDay(clock.startOfLocalDay(clock.localDay()) - 1),
        });
        return;
      }

      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        if (url.pathname.startsWith('/api/admin/')
          && !originAllowed(req.headers.origin, req.headers.host)) {
          sendError(res, new AppError('forbidden_origin', '这个操作只接受本机页面', {
            status: 403,
          }));
          return;
        }
        const matched = router.match(method, url.pathname);
        if (!matched) {
          sendError(res, new AppError('not_found', '没有找到这个接口', { status: 404 }));
          return;
        }
        await matched.handler({ req, res, url, params: matched.params });
        return;
      }

      if ((method === 'GET' || method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
        await serveFile(res, path.join(WEB_ROOT, 'index.html'), method);
        return;
      }

      if (method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        const filePath = safeStaticPath(url.pathname);
        if (filePath) {
          await serveFile(res, filePath, method);
          return;
        }
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, new AppError('method_not_allowed', '这个地址不支持该操作', { status: 405 }));
        return;
      }

      sendError(res, new AppError('not_found', '没有找到这个页面', { status: 404 }));
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      if (status >= 500) {
        log.error('http_request_failed', {
          method: req.method,
          path: req.url,
          code: err instanceof AppError ? err.code : 'internal',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      sendError(res, err);
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  server.on('clientError', (err, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  function listen(port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: '127.0.0.1', port });
    });
  }

  return {
    get port() {
      return actualPort;
    },

    async start() {
      const requested = Number(config.server.port);
      const maxAttempts = requested === 0 ? 1 : 11;
      let port = requested;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          await listen(port);
          const address = server.address();
          actualPort = typeof address === 'object' && address ? address.port : port;
          listening = true;
          log.info('http_listening', { port: actualPort });
          return { port: actualPort };
        } catch (err) {
          if (err.code === 'EADDRINUSE' && requested !== 0 && attempt < maxAttempts - 1) {
            port += 1;
            continue;
          }
          throw new AppError('port_unavailable', '本地端口被占用，服务没能启动', { cause: err });
        }
      }

      throw new AppError('port_unavailable', '本地端口被占用，服务没能启动', { status: 500 });
    },

    async stop() {
      if (!listening) {
        return;
      }
      listening = false;
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
