import {
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from 'node:crypto';

import { base64Decode, base64Encode, encryptLoginPassword } from './login-crypto';
import type { PasswordEncryptionKey } from './login-crypto';

const RSA_OAEP = 4; // crypto.constants.RSA_PKCS1_OAEP_PADDING

type TestKey = PasswordEncryptionKey & { privateKeyPem: string };

function createTestKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const kid = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return {
    kid,
    public_key: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

function decryptV1(payload: string, key: TestKey): string {
  const ciphertext = Buffer.from(base64Decode(payload));
  expect(ciphertext.length).toBe(256);
  return privateDecrypt(
    { key: key.privateKeyPem, padding: RSA_OAEP, oaepHash: 'sha256' },
    ciphertext,
  ).toString('utf8');
}

function decryptV2(payload: string, key: TestKey): string {
  const parts = payload.split('.');
  expect(parts).toHaveLength(4);
  expect(parts[0]).toBe('v2');
  const wrappedKey = Buffer.from(base64Decode(parts[1]));
  const secret = privateDecrypt(
    {
      key: key.privateKeyPem,
      padding: RSA_OAEP,
      oaepHash: 'sha256',
      oaepLabel: Buffer.from('password-v2'),
    },
    wrappedKey,
  );
  expect(secret.length).toBe(32);
  const sealed = Buffer.from(base64Decode(parts[3]));
  const tag = sealed.subarray(sealed.length - 16);
  const body = sealed.subarray(0, sealed.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(base64Decode(parts[2])));
  decipher.setAAD(Buffer.from(`password-v2:${key.kid}`));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

describe('login-crypto', () => {
  it('base64 编解码与 Node 标准 Base64 一致', () => {
    for (let i = 0; i < 32; i += 1) {
      const bytes = randomBytes(i * 7);
      const encoded = base64Encode(bytes);
      expect(encoded).toBe(bytes.toString('base64'));
      expect(Array.from(base64Decode(encoded))).toEqual(Array.from(bytes));
    }
  });

  it('kid 取自 SPKI DER 的 SHA-256 前 16 字节', () => {
    const key = createTestKey();
    expect(key.kid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('短密码走 v1，可被服务端私钥解开', () => {
    const key = createTestKey();
    const password = 'Str0ng-P@ssw0rd!';
    const encrypted = encryptLoginPassword(password, key);
    expect(encrypted.encryption_key_id).toBe(key.kid);
    expect(encrypted.password_encrypted).not.toContain('v2.');
    expect(decryptV1(encrypted.password_encrypted, key)).toBe(password);
  });

  it('ASCII 密码在 190 字节边界内走 v1、超出走 v2', () => {
    const key = createTestKey();
    const exact = 'a'.repeat(190);
    const over = 'a'.repeat(191);
    expect(encryptLoginPassword(exact, key).password_encrypted).not.toContain('v2.');
    expect(encryptLoginPassword(over, key).password_encrypted.startsWith('v2.')).toBe(true);
  });

  it('长中文密码走 v2，AES-256-GCM 可认证解密', () => {
    const key = createTestKey();
    const password = '中文密码'.repeat(50); // 300 字节 UTF-8
    const encrypted = encryptLoginPassword(password, key);
    expect(encrypted.password_encrypted.startsWith('v2.')).toBe(true);
    expect(decryptV2(encrypted.password_encrypted, key)).toBe(password);
  });

  it('代理对密码同样可解密', () => {
    const key = createTestKey();
    const password = '密码'.repeat(40);
    const encrypted = encryptLoginPassword(password, key);
    expect(encrypted.password_encrypted.startsWith('v2.')).toBe(true);
    expect(decryptV2(encrypted.password_encrypted, key)).toBe(password);
  });

  it('每次加密使用独立随机种子，密文不重复', () => {
    const key = createTestKey();
    const first = encryptLoginPassword('same-password', key);
    const second = encryptLoginPassword('same-password', key);
    expect(first.password_encrypted).not.toBe(second.password_encrypted);
  });
});
