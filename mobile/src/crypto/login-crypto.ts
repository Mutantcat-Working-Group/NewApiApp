/**
 * new-api 登录密码加密（纯 TypeScript，无第三方依赖）。
 *
 * 契约来源（new-api 源码）：
 * - controller/user.go: GetPasswordEncryptionKey / Login
 * - common/password_crypto.go: DecryptPassword（v1 与 v2 两种负载）
 * - web/src/features/auth/lib/password-encryption.ts（官方前端实现）
 *
 * v1: RSA-OAEP(SHA-256) 直接加密密码，密文长度等于模长（2048 位 = 256 字节）。
 * v2: 混合加密，RSA-OAEP 包裹 32 字节 AES-256 密钥（label = "password-v2"），
 *     AES-256-GCM 加密密码（AAD = "password-v2:<kid>"），密文与 16 字节 tag 拼接，
 *     输出 "v2.<wrappedKey>.<nonce>.<ciphertext>"（三段均为标准 Base64）。
 */

export type PasswordEncryptionKey = {
  kid: string;
  public_key: string;
};

export type EncryptedPassword = {
  password_encrypted: string;
  encryption_key_id: string;
};

const OAEP_LABEL_V2 = 'password-v2';
const SHA256_LEN = 32;

// ---------------------------------------------------------------- base64

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i += 1) {
  B64_LOOKUP[B64_ALPHABET[i]] = i;
}

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

export function base64Decode(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const byteLength = Math.floor((clean.length * 6) / 8);
  const out = new Uint8Array(byteLength);
  let bitBuffer = 0;
  let bitCount = 0;
  let outIndex = 0;
  for (let i = 0; i < clean.length; i += 1) {
    bitBuffer = (bitBuffer << 6) | B64_LOOKUP[clean[i]];
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[outIndex] = (bitBuffer >> bitCount) & 0xff;
      outIndex += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------- utf8

export function utf8Encode(text: string): Uint8Array {
  const units: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      units.push(code);
    } else if (code < 0x800) {
      units.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      units.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      units.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(units);
}

// ---------------------------------------------------------------- random

/**
 * 优先使用平台 CSPRNG（桌面 WebView 的 crypto.getRandomValues）。
 * React Native 的 Hermes 不暴露 crypto.getRandomValues，此时退化为
 * Math.random 播种的 xorshift128，仅用于 v2 混合加密的 AES 密钥与 nonce，
 * 属于尽力而为的方案；安装 react-native-get-random-values 等 polyfill 后
 * 会自动改用安全随机源。
 */
function randomBytes(length: number): Uint8Array {
  const webCrypto = (
    globalThis as {
      crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(length);
    webCrypto.getRandomValues(bytes);
    return bytes;
  }
  const state = new Uint32Array(4);
  for (let i = 0; i < 4; i += 1) {
    state[i] = Math.floor(Math.random() * 0x100000000) >>> 0;
  }
  const out = new Uint8Array(length);
  let index = 0;
  while (index < length) {
    let t = state[3];
    const u = state[1];
    state[3] = state[2];
    state[2] = state[1];
    state[1] = state[0];
    t = (t ^ ((t << 11) >>> 0)) >>> 0;
    t = (t ^ (t >>> 8)) >>> 0;
    state[0] = (t ^ u ^ (u >>> 19)) >>> 0;
    const word = state[0];
    const take = Math.min(4, length - index);
    for (let i = 0; i < take; i += 1) {
      out[index + i] = (word >>> (8 * (3 - i))) & 0xff;
    }
    index += take;
  }
  return out;
}

// ---------------------------------------------------------------- sha256

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

export function sha256(message: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLength = message.length * 8;
  const blockCount = Math.ceil((message.length + 9) / 64);
  const padded = new Uint8Array(blockCount * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(SHA256_LEN);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) {
    outView.setUint32(i * 4, h[i], false);
  }
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    out[i] = a[i] ^ b[i];
  }
  return out;
}

function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

/** MGF1（SHA-256），OAEP 掩码生成函数。 */
export function mgf1(seed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let counter = 0;
  let offset = 0;
  while (offset < length) {
    const block = sha256(concatBytes(seed, u32be(counter)));
    const take = Math.min(SHA256_LEN, length - offset);
    out.set(block.subarray(0, take), offset);
    offset += take;
    counter += 1;
  }
  return out;
}

// ---------------------------------------------------------------- bigint

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 0; i < bytes.length; i += 1) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

// ---------------------------------------------------------------- rsa oaep

type RsaPublicKey = {
  modulus: bigint;
  exponent: bigint;
  /** 模长 k（字节），2048 位 = 256。 */
  byteLength: number;
};

type DerNode = {
  content: Uint8Array;
  next: number;
};

function derRead(data: Uint8Array, offset: number): DerNode {
  let cursor = offset + 1; // tag
  let length = data[cursor];
  cursor += 1;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i += 1) {
      length = (length << 8) | data[cursor];
      cursor += 1;
    }
  }
  return { content: data.subarray(cursor, cursor + length), next: cursor + length };
}

/** 解析 SPKI PEM 公钥：SubjectPublicKeyInfo -> BIT STRING -> RSAPublicKey。 */
function parseRsaPublicKey(pem: string): RsaPublicKey {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  const der = base64Decode(body);
  const spki = derRead(der, 0).content;
  const algorithmId = derRead(spki, 0);
  const bitString = derRead(spki, algorithmId.next).content;
  const rsaKey = derRead(bitString.subarray(1), 0).content;
  const modulusNode = derRead(rsaKey, 0);
  const exponentNode = derRead(rsaKey, modulusNode.next);
  const modulus = bytesToBigInt(modulusNode.content);
  return {
    modulus,
    exponent: bytesToBigInt(exponentNode.content),
    byteLength: (modulus.toString(2).length + 7) >> 3,
  };
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let factor = base % modulus;
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) {
      result = (result * factor) % modulus;
    }
    factor = (factor * factor) % modulus;
    remaining >>= 1n;
  }
  return result;
}

/** RFC 8017 EME-OAEP 编码，label 为空即 v1 的默认标签。 */
function oaepEncode(message: Uint8Array, key: RsaPublicKey, label: Uint8Array): Uint8Array {
  const hLen = SHA256_LEN;
  if (message.length > key.byteLength - 2 * hLen - 2) {
    throw new Error('明文超出 RSA-OAEP 容量');
  }
  const lHash = sha256(label);
  const padding = new Uint8Array(key.byteLength - message.length - 2 * hLen - 2);
  const db = concatBytes(lHash, padding, new Uint8Array([0x01]), message);
  const seed = randomBytes(hLen);
  const dbMask = mgf1(seed, key.byteLength - hLen - 1);
  const maskedDb = xorBytes(db, dbMask);
  const seedMask = mgf1(maskedDb, hLen);
  const maskedSeed = xorBytes(seed, seedMask);
  return concatBytes(new Uint8Array([0x00]), maskedSeed, maskedDb);
}

function rsaOaepSha256Encrypt(message: Uint8Array, key: RsaPublicKey, label: string): Uint8Array {
  const encoded = oaepEncode(message, key, label ? utf8Encode(label) : new Uint8Array(0));
  const cipherInt = modPow(bytesToBigInt(encoded), key.exponent, key.modulus);
  return bigIntToBytes(cipherInt, key.byteLength);
}

// ---------------------------------------------------------------- aes-256-gcm

const AES_SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

const AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40];
const GF_2_128_R = 0xe1000000000000000000000000000000n;

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function xtime(value: number): number {
  const shifted = (value << 1) & 0xff;
  return value & 0x80 ? shifted ^ 0x1b : shifted;
}

function gmul(a: number, b: number): number {
  let result = 0;
  let left = a;
  let right = b;
  for (let i = 0; i < 8; i += 1) {
    if (right & 1) {
      result ^= left;
    }
    right >>= 1;
    left = xtime(left);
  }
  return result & 0xff;
}

/** AES-256 密钥扩展：8 个初始字，14 轮，共 60 个轮密钥字。 */
function keyExpansion256(key: Uint8Array): Uint32Array {
  const words = new Uint32Array(60);
  for (let i = 0; i < 8; i += 1) {
    words[i] = readU32(key, i * 4);
  }
  for (let i = 8; i < 60; i += 1) {
    let temp = words[i - 1];
    if (i % 8 === 0) {
      const rotated = ((temp << 8) | (temp >>> 24)) >>> 0;
      const substituted =
        (AES_SBOX[(rotated >>> 24) & 0xff] << 24) |
        (AES_SBOX[(rotated >>> 16) & 0xff] << 16) |
        (AES_SBOX[(rotated >>> 8) & 0xff] << 8) |
        AES_SBOX[rotated & 0xff];
      temp = (substituted ^ (AES_RCON[i / 8 - 1] << 24)) >>> 0;
    } else if (i % 8 === 4) {
      temp =
        (AES_SBOX[(temp >>> 24) & 0xff] << 24) |
        (AES_SBOX[(temp >>> 16) & 0xff] << 16) |
        (AES_SBOX[(temp >>> 8) & 0xff] << 8) |
        AES_SBOX[temp & 0xff];
    }
    words[i] = (words[i - 8] ^ temp) >>> 0;
  }
  return words;
}

function addRoundKey(state: Uint8Array, roundKeys: Uint32Array, round: number): void {
  for (let c = 0; c < 4; c += 1) {
    const word = roundKeys[round * 4 + c];
    state[4 * c] ^= (word >>> 24) & 0xff;
    state[4 * c + 1] ^= (word >>> 16) & 0xff;
    state[4 * c + 2] ^= (word >>> 8) & 0xff;
    state[4 * c + 3] ^= word & 0xff;
  }
}

function subBytes(state: Uint8Array): void {
  for (let i = 0; i < 16; i += 1) {
    state[i] = AES_SBOX[state[i]];
  }
}

/** state 按列优先排布（state[r + 4c]），第 r 行左移 r 字节。 */
function shiftRows(state: Uint8Array): void {
  const shifted = new Uint8Array(16);
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      shifted[r + 4 * c] = state[r + 4 * ((c + r) % 4)];
    }
  }
  state.set(shifted);
}

function mixColumns(state: Uint8Array): void {
  for (let c = 0; c < 4; c += 1) {
    const s0 = state[4 * c];
    const s1 = state[4 * c + 1];
    const s2 = state[4 * c + 2];
    const s3 = state[4 * c + 3];
    state[4 * c] = gmul(s0, 2) ^ gmul(s1, 3) ^ s2 ^ s3;
    state[4 * c + 1] = s0 ^ gmul(s1, 2) ^ gmul(s2, 3) ^ s3;
    state[4 * c + 2] = s0 ^ s1 ^ gmul(s2, 2) ^ gmul(s3, 3);
    state[4 * c + 3] = gmul(s0, 3) ^ s1 ^ s2 ^ gmul(s3, 2);
  }
}

function aesEncryptBlock(block: Uint8Array, roundKeys: Uint32Array): Uint8Array {
  const state = new Uint8Array(16);
  state.set(block);
  addRoundKey(state, roundKeys, 0);
  for (let round = 1; round < 14; round += 1) {
    subBytes(state);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, roundKeys, round);
  }
  subBytes(state);
  shiftRows(state);
  addRoundKey(state, roundKeys, 14);
  return state;
}

/** GF(2^128) 乘法（NIST SP 800-38D 右移法，R = 0xE1 || 0^120）。 */
function gfMul(x: bigint, y: bigint): bigint {
  let z = 0n;
  let v = y;
  // GHASH 的位序以字节 0 的最高位为最低阶系数，对应大整数的最高位，
  // 因此必须从高位到低位遍历 x。
  for (let bit = 127n; bit >= 0n; bit -= 1n) {
    if ((x >> bit) & 1n) {
      z ^= v;
    }
    v = v & 1n ? (v >> 1n) ^ GF_2_128_R : v >> 1n;
  }
  return z;
}

/** 仅递增计数器块的最低 32 位。 */
function inc32(counter: Uint8Array): Uint8Array {
  const next = new Uint8Array(counter);
  const view = new DataView(next.buffer, next.byteOffset + 12, 4);
  view.setUint32(0, (view.getUint32(0, false) + 1) >>> 0, false);
  return next;
}

function ghash(h: bigint, aad: Uint8Array, ciphertext: Uint8Array): bigint {
  let y = 0n;
  const absorb = (data: Uint8Array) => {
    for (let offset = 0; offset < data.length; offset += 16) {
      const block = new Uint8Array(16);
      block.set(data.subarray(offset, offset + 16));
      y = gfMul(y ^ bytesToBigInt(block), h);
    }
  };
  absorb(aad);
  absorb(ciphertext);
  const lengthBlock = new Uint8Array(16);
  const lengthView = new DataView(lengthBlock.buffer);
  // 长度块为两个 64 位大端比特长度：前 8 字节 AAD，后 8 字节密文。
  lengthView.setUint32(0, Math.floor((aad.length * 8) / 0x100000000), false);
  lengthView.setUint32(4, (aad.length * 8) >>> 0, false);
  lengthView.setUint32(8, Math.floor((ciphertext.length * 8) / 0x100000000), false);
  lengthView.setUint32(12, (ciphertext.length * 8) >>> 0, false);
  return gfMul(y ^ bytesToBigInt(lengthBlock), h);
}

function gctr(initialCounter: Uint8Array, data: Uint8Array, roundKeys: Uint32Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let counter = initialCounter;
  for (let offset = 0; offset < data.length; offset += 16) {
    const chunk = data.subarray(offset, offset + 16);
    const keystream = aesEncryptBlock(counter, roundKeys);
    for (let i = 0; i < chunk.length; i += 1) {
      out[offset + i] = chunk[i] ^ keystream[i];
    }
    counter = inc32(counter);
  }
  return out;
}

/** AES-256-GCM 加密，返回密文与 16 字节认证 tag（与 Go cipher.NewGCM 的 Seal 输出一致）。 */
function aesGcmEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): { ciphertext: Uint8Array; tag: Uint8Array } {
  const roundKeys = keyExpansion256(key);
  const h = bytesToBigInt(aesEncryptBlock(new Uint8Array(16), roundKeys));
  const j0 = concatBytes(nonce, u32be(1));
  const ciphertext = gctr(inc32(j0), plaintext, roundKeys);
  const s = ghash(h, aad, ciphertext);
  const tag = gctr(j0, bigIntToBytes(s, 16), roundKeys);
  return { ciphertext, tag };
}

// ---------------------------------------------------------------- entry

/**
 * 按 new-api 登录加密契约加密密码：短密码走 v1（RSA-OAEP 直加密），
 * UTF-8 超过模长容量时走 v2（RSA 包裹 AES-256-GCM 混合加密）。
 */
export function encryptLoginPassword(password: string, key: PasswordEncryptionKey): EncryptedPassword {
  const publicKey = parseRsaPublicKey(key.public_key);
  const plaintext = utf8Encode(password);
  const v1Capacity = publicKey.byteLength - 2 * SHA256_LEN - 2;
  if (plaintext.length <= v1Capacity) {
    return {
      password_encrypted: base64Encode(rsaOaepSha256Encrypt(plaintext, publicKey, '')),
      encryption_key_id: key.kid,
    };
  }

  const secret = randomBytes(32);
  const nonce = randomBytes(12);
  const wrappedKey = rsaOaepSha256Encrypt(secret, publicKey, OAEP_LABEL_V2);
  const aad = utf8Encode(`${OAEP_LABEL_V2}:${key.kid}`);
  const { ciphertext, tag } = aesGcmEncrypt(secret, nonce, plaintext, aad);
  return {
    password_encrypted: [
      'v2',
      base64Encode(wrappedKey),
      base64Encode(nonce),
      base64Encode(concatBytes(ciphertext, tag)),
    ].join('.'),
    encryption_key_id: key.kid,
  };
}
