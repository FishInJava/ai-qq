import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors.js';
import { parseCardText } from './parse.js';
import { extractCharaText, isPng, makePlaceholderPng, replaceCharaText } from './png.js';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_TOKENS = 8;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function decodeUtf8(buffer) {
  try {
    return UTF8.decode(buffer);
  } catch (err) {
    throw new AppError('card_data_invalid', '卡片数据损坏，解析不了', { status: 400, cause: err });
  }
}

function classifyUpload(buffer, filename) {
  if (typeof filename !== 'string' || filename.trim() === '') {
    throw new AppError('missing_filename', '缺少文件名', { status: 400 });
  }
  if (buffer.length === 0) {
    throw new AppError('card_empty', '卡片文件是空的', { status: 400 });
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new AppError('card_too_large', '卡片文件不能超过 20MB', { status: 413 });
  }

  const extension = path.extname(filename).toLowerCase();
  if (extension !== '.png' && extension !== '.json') {
    throw new AppError('card_unsupported_type', '只支持 PNG 或 JSON 角色卡', { status: 400 });
  }

  if (extension === '.png') {
    if (!isPng(buffer)) {
      throw new AppError('card_png_invalid', '这张图不是角色卡（没找到角色数据块）', { status: 400 });
    }
    return { ext: 'png', jsonText: extractCharaText(buffer) };
  }

  return { ext: 'json', jsonText: decodeUtf8(buffer) };
}

function safeDataPath(dataDir, relativePath) {
  const root = path.resolve(dataDir);
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new AppError('path_invalid', '文件路径不合法', { status: 500 });
  }
  return absolute;
}

function restoreBackups(backups, log) {
  for (const backup of backups) {
    try {
      writeFileSync(backup.absolute, backup.bytes);
    } catch (err) {
      log?.warn('card_file_restore_failed', { path: backup.absolute, message: err.message });
    }
  }
}

function removeCreatedFiles(created, log) {
  for (const absolute of created) {
    try {
      rmSync(absolute, { force: true });
    } catch (err) {
      log?.warn('card_file_cleanup_failed', { path: absolute, message: err.message });
    }
  }
}

export function createCards({ store, clock, config, dataDir, bus, log }) {
  const pendingTokens = new Map();

  function sweepTokens() {
    const now = clock.now();
    for (const [token, pending] of pendingTokens) {
      if (now - pending.createdAt > TOKEN_TTL_MS) {
        pendingTokens.delete(token);
      }
    }
    while (pendingTokens.size >= MAX_PENDING_TOKENS) {
      const oldest = pendingTokens.keys().next().value;
      pendingTokens.delete(oldest);
    }
  }

  function preview(buffer, filename) {
    sweepTokens();
    const { ext, jsonText } = classifyUpload(buffer, filename);
    const parsed = parseCardText(jsonText);
    const hash = sha256(jsonText);
    const existing = store.characters.findByHash(hash);
    const token = randomUUID();

    pendingTokens.set(token, {
      token,
      hash,
      jsonText,
      bytes: Buffer.from(buffer),
      ext,
      ...parsed,
      createdAt: clock.now(),
    });

    log?.event('card_preview', {
      bytes: buffer.length,
      compat: parsed.compat,
      duplicate: existing !== null,
    });

    return {
      token,
      name: parsed.name,
      description: parsed.description,
      tags: [...parsed.tags],
      compat: parsed.compat,
      has_scripts: parsed.hasScripts,
      has_book: parsed.hasBook,
      duplicate: existing ? { id: existing.id } : null,
    };
  }

  function writeCardFiles({ characterId, ext, bytes, backups, created }) {
    mkdirSync(path.join(dataDir, 'cards'), { recursive: true });
    mkdirSync(path.join(dataDir, 'avatars'), { recursive: true });

    const cardSourcePath = `cards/${characterId}.${ext}`;
    const avatarPath = ext === 'png' ? `avatars/${characterId}.png` : null;

    const writeTracked = (relativePath) => {
      const absolute = safeDataPath(dataDir, relativePath);
      if (existsSync(absolute)) {
        backups.push({ absolute, bytes: readFileSync(absolute) });
      } else {
        created.push(absolute);
      }
      writeFileSync(absolute, bytes);
    };

    writeTracked(cardSourcePath);
    if (avatarPath !== null) {
      writeTracked(avatarPath);
    }

    return { cardSourcePath, avatarPath };
  }

  function removeStaleFile(relativePath) {
    if (!relativePath) {
      return;
    }
    const absolute = safeDataPath(dataDir, relativePath);
    try {
      rmSync(absolute, { force: true });
    } catch (err) {
      log?.warn('card_stale_file_remove_failed', { path: relativePath, message: err.message });
    }
  }

  function commit(token, mode) {
    sweepTokens();

    if (mode !== 'new' && mode !== 'overwrite') {
      throw new AppError('invalid_mode', '导入方式不对', { status: 400 });
    }

    const pending = pendingTokens.get(token);
    if (!pending) {
      throw new AppError('preview_expired', '预览已过期，请重新选择卡片', { status: 410 });
    }

    const existing = store.characters.findByHash(pending.hash);
    if (existing && mode === 'new') {
      throw new AppError('card_duplicate', '这张卡已经在库里了', { status: 409 });
    }

    const backups = [];
    const created = [];
    let result;

    try {
      result = store.tx(() => {
        const importedAt = clock.iso();
        const characterId = existing
          ? existing.id
          : store.characters.insert({
            name: pending.name,
            cardJson: pending.jsonText,
            extensionsJson: pending.extensionsJson,
            compat: pending.compat,
            avatarPath: null,
            cardSourcePath: null,
            sourceHash: pending.hash,
            importedAt,
          });

        const files = writeCardFiles({
          characterId,
          ext: pending.ext,
          bytes: pending.bytes,
          backups,
          created,
        });

        store.characters.update(characterId, {
          name: pending.name,
          cardJson: pending.jsonText,
          extensionsJson: pending.extensionsJson,
          compat: pending.compat,
          avatarPath: files.avatarPath,
          cardSourcePath: files.cardSourcePath,
          sourceHash: pending.hash,
          importedAt,
        });

        let session = store.sessions.findByCharacterId(characterId);
        if (!session) {
          const sessionId = store.sessions.insert({
            characterId,
            state: 'unstarted',
            tokenLimit: config.quota.default_token_limit,
            createdAt: importedAt,
          });
          session = store.sessions.findById(sessionId);
        }

        return { characterId, session, files };
      });
    } catch (err) {
      restoreBackups(backups, log);
      removeCreatedFiles(created, log);
      throw err;
    }

    if (existing) {
      const currentSource = result.files.cardSourcePath;
      const currentAvatar = result.files.avatarPath;
      if (existing.card_source_path && existing.card_source_path !== currentSource) {
        removeStaleFile(existing.card_source_path);
      }
      if (existing.avatar_path && existing.avatar_path !== currentAvatar) {
        removeStaleFile(existing.avatar_path);
      }
    }

    pendingTokens.delete(token);

    const card = store.characters.findById(result.characterId);
    log?.event('card_imported', {
      card_id: card.id,
      compat: card.compat,
      duplicate: existing !== null,
    });
    bus.emit('import', {
      card_id: card.id,
      session_id: result.session.id,
      duplicate: existing !== null,
    });

    return {
      card: {
        id: card.id,
        name: card.name,
        compat: card.compat,
        avatar_url: card.avatar_path ? `/api/cards/${card.id}/avatar` : null,
      },
      session: {
        id: result.session.id,
        character_id: result.session.character_id,
        state: result.session.state,
        token_limit: result.session.token_limit,
        token_used: result.session.token_used,
      },
    };
  }

  function avatar(characterId) {
    const card = store.characters.findById(characterId);
    if (!card || !card.avatar_path) {
      return null;
    }
    const absolute = safeDataPath(dataDir, card.avatar_path);
    if (!existsSync(absolute)) {
      log?.warn('card_avatar_missing', { card_id: card.id });
      return null;
    }
    return { filePath: absolute, contentType: 'image/png' };
  }

  function exportFilename(name, id) {
    const cleaned = String(name ?? '')
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 80);
    return cleaned === '' ? `card-${id}` : cleaned;
  }

  function exportCard(characterId, format) {
    const card = store.characters.findById(characterId);
    if (!card) {
      throw new AppError('card_not_found', '没有找到这张卡', { status: 404 });
    }

    const baseName = exportFilename(card.name, card.id);

    if (format === 'json') {
      return {
        buffer: Buffer.from(card.card_json, 'utf8'),
        contentType: 'application/json; charset=utf-8',
        filename: `${baseName}.json`,
      };
    }

    if (format !== 'png') {
      throw new AppError('invalid_format', '只支持导出 PNG 或 JSON', { status: 400 });
    }

    let source = null;
    if (typeof card.card_source_path === 'string'
      && card.card_source_path.toLowerCase().endsWith('.png')) {
      const absolute = safeDataPath(dataDir, card.card_source_path);
      if (existsSync(absolute)) {
        source = readFileSync(absolute);
      } else {
        log?.warn('card_source_missing', { card_id: card.id });
      }
    }

    return {
      buffer: source === null
        ? makePlaceholderPng(card.card_json)
        : replaceCharaText(source, card.card_json),
      contentType: 'image/png',
      filename: `${baseName}.png`,
    };
  }

  function remove(characterId, scope) {
    if (scope !== 'card' && scope !== 'records') {
      throw new AppError('invalid_scope', '删除范围不对', { status: 400 });
    }

    const card = store.characters.findById(characterId);
    if (!card) {
      throw new AppError('card_not_found', '没有找到这张卡', { status: 404 });
    }

    const staleFiles = [card.card_source_path, card.avatar_path].filter(Boolean);

    store.tx(() => {
      const session = store.sessions.findByCharacterId(characterId);
      if (scope === 'records' && session) {
        if (session.state === 'active') {
          store.sessions.setState(session.id, 'paused');
        }
        store.sessions.remove(session.id);
      }
      store.characters.remove(characterId);
    });

    for (const relativePath of staleFiles) {
      removeStaleFile(relativePath);
    }

    log?.event('card_removed', {
      card_id: characterId,
      scope,
      files: staleFiles.length,
    });

    return { ok: true };
  }

  return {
    preview,
    commit,
    avatar,
    exportCard,
    remove,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
}
