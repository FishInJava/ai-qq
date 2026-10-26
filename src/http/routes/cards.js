import { readFile } from 'node:fs/promises';
import { AppError } from '../../errors.js';
import { readBody, readJson, sendBuffer, sendJson } from '../respond.js';

const JSON_BODY_LIMIT = 64 * 1024;

function filenameFromHeader(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return '';
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cardId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('card_not_found', '没有找到这张卡', { status: 404 });
  }
  return id;
}

function contentDisposition(filename, id, format) {
  const ascii = /^[\x20-\x7e]+$/.test(filename)
    ? filename.replace(/["\\]/g, '_')
    : `card-${id}.${format}`;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * @param {ReturnType<import('../router.js').createRouter>} router
 * @param {{
 *   cards: object,
 *   library: object,
 *   session: object,
 * }} services
 */
export function registerCardRoutes(router, { cards, library, session }) {
  router.add('GET', '/api/cards', ({ res, url }) => {
    sendJson(res, 200, library.list({ q: url.searchParams.get('q') ?? '' }));
  });

  router.add('POST', '/api/cards/preview', async ({ req, res }) => {
    const filename = filenameFromHeader(req.headers['x-filename']);
    const buffer = await readBody(req, cards.maxUploadBytes, '卡片文件不能超过 20MB');
    const preview = cards.preview(buffer, filename);
    sendJson(res, 200, preview);
  });

  router.add('POST', '/api/cards/commit', async ({ req, res }) => {
    const body = await readJson(req, JSON_BODY_LIMIT);
    if (body === null || typeof body !== 'object') {
      throw new AppError('invalid_commit', '导入请求不完整', { status: 400 });
    }
    const result = cards.commit(body.token, body.mode);
    sendJson(res, 200, {
      card: result.card,
      session: session.view(result.session.id),
    });
  });

  router.add('GET', '/api/cards/:id/avatar', async ({ res, params }) => {
    const file = cards.avatar(cardId(params.id));
    if (!file) {
      throw new AppError('avatar_not_found', '这张卡没有头像', { status: 404 });
    }
    let buffer;
    try {
      buffer = await readFile(file.filePath);
    } catch (err) {
      throw new AppError('avatar_not_found', '这张卡没有头像', { status: 404, cause: err });
    }
    sendBuffer(res, 200, buffer, file.contentType, {
      'Cache-Control': 'private, max-age=60',
    });
  });

  router.add('GET', '/api/cards/:id/export', ({ res, params, url }) => {
    const id = cardId(params.id);
    const format = (url.searchParams.get('format') ?? 'json').toLowerCase();
    const file = cards.exportCard(id, format);
    sendBuffer(res, 200, file.buffer, file.contentType, {
      'Content-Disposition': contentDisposition(file.filename, id, format),
      'Cache-Control': 'no-store',
    });
  });

  router.add('DELETE', '/api/cards/:id', ({ res, params, url }) => {
    const scope = url.searchParams.get('scope') ?? 'card';
    const result = cards.remove(cardId(params.id), scope);
    sendJson(res, 200, result);
  });

  router.add('POST', '/api/cards/:id/start', ({ res, params }) => {
    const sessionView = session.start(cardId(params.id));
    sendJson(res, 200, { session: sessionView });
  });
}
