import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { AppError } from '../errors.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function textChunk(keyword, text) {
  return buildChunk(
    'tEXt',
    Buffer.concat([
      Buffer.from(keyword, 'latin1'),
      Buffer.from([0]),
      Buffer.from(text, 'latin1'),
    ]),
  );
}

function charaTextOf(jsonText) {
  return Buffer.from(jsonText, 'utf8').toString('base64');
}

function walkChunks(buffer, onChunk) {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new AppError('card_source_invalid', '原卡文件损坏，导出不了', { status: 500 });
    }
    onChunk({ type, data: buffer.subarray(dataStart, dataEnd), raw: buffer.subarray(offset, dataEnd + 4) });
    offset = dataEnd + 4;
    if (type === 'IEND') {
      break;
    }
  }
}

/**
 * 复用原图字节，只替换 `tEXt` key=chara 的内容；其余 chunk 原样拷贝。
 * 找不到 chara 块时在 IEND 前补一个。
 *
 * @param {Buffer} buffer
 * @param {string} jsonText
 * @returns {Buffer}
 */
export function replaceCharaText(buffer, jsonText) {
  if (!isPng(buffer)) {
    throw new AppError('card_source_invalid', '原卡文件损坏，导出不了', { status: 500 });
  }

  const base64 = charaTextOf(jsonText);
  const parts = [PNG_SIGNATURE];
  let replaced = false;
  let sawIend = false;

  walkChunks(buffer, ({ type, data, raw }) => {
    if (type === 'IEND' && !replaced) {
      parts.push(textChunk('chara', base64));
      replaced = true;
    }
    if (type === 'IEND') {
      sawIend = true;
    }

    if (type === 'tEXt') {
      const separator = data.indexOf(0);
      if (separator > 0 && data.toString('latin1', 0, separator) === 'chara') {
        if (!replaced) {
          parts.push(textChunk('chara', base64));
          replaced = true;
        }
        return;
      }
    }

    parts.push(raw);
  });

  if (!sawIend) {
    throw new AppError('card_source_invalid', '原卡文件损坏，导出不了', { status: 500 });
  }

  return Buffer.concat(parts);
}

const PLACEHOLDER_COLORS = [
  [217, 195, 174],
  [190, 160, 142],
  [172, 184, 168],
  [196, 176, 160],
  [168, 176, 190],
  [206, 184, 166],
];

/**
 * JSON 导入的卡没有原图，导出 PNG 时用一张纯色占位图包住原始卡片文本。
 * 颜色由卡片文本决定，同一张卡每次导出的图一致。
 *
 * @param {string} jsonText
 * @returns {Buffer}
 */
export function makePlaceholderPng(jsonText) {
  const size = 160;
  const digest = createHash('sha256').update(jsonText, 'utf8').digest();
  const [red, green, blue] = PLACEHOLDER_COLORS[digest[0] % PLACEHOLDER_COLORS.length];

  const raw = Buffer.alloc((1 + size * 4) * size);
  for (let row = 0; row < size; row += 1) {
    const rowStart = row * (1 + size * 4);
    raw[rowStart] = 0;
    for (let column = 0; column < size; column += 1) {
      const pixel = rowStart + 1 + column * 4;
      raw[pixel] = red;
      raw[pixel + 1] = green;
      raw[pixel + 2] = blue;
      raw[pixel + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    buildChunk('IHDR', ihdr),
    textChunk('chara', charaTextOf(jsonText)),
    buildChunk('IDAT', deflateSync(raw, { level: 9 })),
    buildChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isPng(buffer) {
  return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * 严格 base64：SillyTavern 写出的 chara 块是标准 base64，不允许夹杂任意字符。
 *
 * @param {string} text
 * @returns {Buffer}
 */
function decodeBase64(text) {
  const compact = text.replace(/\s+/g, '');
  if (compact.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new AppError('card_data_invalid', '卡片数据损坏，解析不了', { status: 400 });
  }
  const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, '=');
  if (padded.length % 4 !== 0) {
    throw new AppError('card_data_invalid', '卡片数据损坏，解析不了', { status: 400 });
  }
  return Buffer.from(padded, 'base64');
}

/**
 * 从 PNG 的 tEXt 块中取 key=chara 的 base64 JSON 文本。
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function extractCharaText(buffer) {
  if (!isPng(buffer)) {
    throw new AppError('card_png_invalid', '这张图不是角色卡（没找到角色数据块）', { status: 400 });
  }

  let offset = PNG_SIGNATURE.length;
  let charaText = null;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > buffer.length) {
      throw new AppError('card_png_invalid', '卡片数据损坏，解析不了', { status: 400 });
    }

    if (type === 'tEXt') {
      const data = buffer.subarray(dataStart, dataEnd);
      const separator = data.indexOf(0);
      if (separator > 0) {
        const keyword = data.toString('latin1', 0, separator);
        if (keyword === 'chara') {
          charaText = data.toString('latin1', separator + 1);
          break;
        }
      }
    }

    if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  if (charaText === null) {
    throw new AppError('card_png_invalid', '这张图不是角色卡（没找到角色数据块）', { status: 400 });
  }

  let decoded;
  try {
    decoded = UTF8.decode(decodeBase64(charaText));
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError('card_data_invalid', '卡片数据损坏，解析不了', { status: 400, cause: err });
  }

  return decoded;
}
