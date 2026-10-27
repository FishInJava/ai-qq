import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function textChunk(keyword, text) {
  return chunk(
    'tEXt',
    Buffer.concat([
      Buffer.from(keyword, 'latin1'),
      Buffer.from([0]),
      Buffer.from(text, 'latin1'),
    ]),
  );
}

function physChunk() {
  const data = Buffer.alloc(9);
  data.writeUInt32BE(2835, 0);
  data.writeUInt32BE(2835, 4);
  data[8] = 1;
  return chunk('pHYs', data);
}

export function makePngCard(card, { pixel = [180, 107, 79, 255], keyword = 'chara' } = {}) {
  const jsonText = typeof card === 'string' ? card : JSON.stringify(card);
  const base64 = Buffer.from(jsonText, 'utf8').toString('base64');

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(Buffer.from([0, ...pixel]));

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    textChunk(keyword, base64),
    physChunk(),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function makeV2Card(overrides = {}) {
  const {
    name = '林夏',
    description = '住在城南的插画师，慢热，喜欢在雨天画画。',
    tags = ['日常', '慢热'],
    extensions = {},
    characterBook = null,
    ...dataOverrides
  } = overrides;

  const data = {
    name,
    description,
    personality: '安静，观察力好，不擅长直接表达关心。',
    scenario: '你和她住在同一栋楼。',
    first_mes: '你回来啦。',
    mes_example: '{{user}}：今天怎么样？\n{{char}}：还行，画了一下午。',
    tags,
    extensions,
    ...dataOverrides,
  };
  if (characterBook !== null) {
    data.character_book = characterBook;
  }

  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data,
  };
}

export function makeV1Card(overrides = {}) {
  return {
    name: '顾青',
    description: '楼下花店的老板。',
    personality: '话少，记性好。',
    scenario: '花店打烊之后。',
    first_mes: '要关门了，你来得正好。',
    mes_example: '{{user}}：还有花吗？\n{{char}}：有，给你留了一枝。',
    ...overrides,
  };
}

export function jsonBytes(card) {
  return Buffer.from(`${JSON.stringify(card, null, 2)}\n`, 'utf8');
}
