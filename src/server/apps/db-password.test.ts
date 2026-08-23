import { createCipheriv, hkdfSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const APP_ID = 'demo-app';
const PASSWORD = '0123456789abcdef'.repeat(4);
// Produced by the pre-refactor implementation with IV 0x07 repeated 12 times.
const LEGACY_V1_FIXTURE =
  'v1.BwcHBwcHBwcHBwcH.0XA3umaiGqJac5mF3bPHfCfXuC8xtcu2EcOJ2VzjHxiDFBTxJH4b_5Z4lmVOBKAQn3NOWN6E-BPhe2aQKOesOA.5sZ4BNA7IIBGOUghhQKp0Q';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('APP_URL', 'https://public.example.test');
  vi.stubEnv('SECRET', 'platform-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadPasswordModule(secret = 'platform-secret') {
  vi.stubEnv('SECRET', secret);
  vi.resetModules();
  return import('./db-password');
}

function encryptInvalidPlaintext(appId: string, plaintext: string): string {
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from('platform-secret'),
      Buffer.alloc(0),
      Buffer.from('my-space/app-db-password/aes-256-gcm/v1'),
      32,
    ),
  );
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(`my-space/app-db-password/v1:${appId}`));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

describe('app database passwords', () => {
  it('generates 32 random bytes as lowercase hexadecimal', async () => {
    const { generateAppDbPassword } = await loadPasswordModule();
    const first = generateAppDbPassword();
    const second = generateAppDbPassword();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });

  it('decrypts a v1 ciphertext produced before the envelope refactor', async () => {
    const { decryptAppDbPassword } = await loadPasswordModule();

    expect(decryptAppDbPassword(APP_ID, LEGACY_V1_FIXTURE)).toBe(PASSWORD);
  });

  it('encrypts Data Table passwords in an independent authenticated domain', async () => {
    const {
      decryptAppDataDbPassword,
      decryptAppDbPassword,
      encryptAppDataDbPassword,
      encryptAppDbPassword,
      generateAppDataDbPassword,
    } = await loadPasswordModule();
    const dataPassword = generateAppDataDbPassword();
    const dataEnvelope = encryptAppDataDbPassword(APP_ID, dataPassword);
    const appEnvelope = encryptAppDbPassword(APP_ID, PASSWORD);

    expect(dataPassword).toMatch(/^[0-9a-f]{64}$/);
    expect(decryptAppDataDbPassword(APP_ID, dataEnvelope)).toBe(dataPassword);
    expect(() => decryptAppDbPassword(APP_ID, dataEnvelope)).toThrow(
      'authentication failed or ciphertext is corrupted',
    );
    expect(() => decryptAppDataDbPassword(APP_ID, appEnvelope)).toThrow(
      'authentication failed or ciphertext is corrupted',
    );
  });

  it('rejects a password that is not 64 lowercase hex characters', async () => {
    const { encryptAppDbPassword } = await loadPasswordModule();

    expect(() => encryptAppDbPassword(APP_ID, 'a'.repeat(63))).toThrow(
      'expected 64 lowercase hexadecimal characters',
    );
    expect(() => encryptAppDbPassword(APP_ID, 'A'.repeat(64))).toThrow(
      'expected 64 lowercase hexadecimal characters',
    );
    expect(() => encryptAppDbPassword(APP_ID, `${'a'.repeat(64)}\n`)).toThrow(
      'expected 64 lowercase hexadecimal characters',
    );
  });

  it('binds ciphertext to the app id', async () => {
    const { decryptAppDbPassword, encryptAppDbPassword } =
      await loadPasswordModule();
    const envelope = encryptAppDbPassword(APP_ID, PASSWORD);

    expect(() => decryptAppDbPassword('other-app', envelope)).toThrow(
      'authentication failed or ciphertext is corrupted',
    );
  });

  it('rejects authenticated plaintext outside the password format', async () => {
    const { decryptAppDbPassword } = await loadPasswordModule();
    const envelope = encryptInvalidPlaintext(APP_ID, 'A'.repeat(64));

    expect(() => decryptAppDbPassword(APP_ID, envelope)).toThrow(
      'authentication failed or ciphertext is corrupted',
    );
  });
});
