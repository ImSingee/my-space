import { createCipheriv, hkdfSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvelopeContext } from './envelope';

const CONTEXT: EnvelopeContext = {
  label: 'test secret',
  domain: 'my-space/test-secret/aes-256-gcm/v1',
  aad: 'my-space/test-secret/v1:demo',
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('APP_URL', 'https://public.example.test');
  vi.stubEnv('SECRET', 'platform-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadEnvelopeModule(secret = 'platform-secret') {
  vi.stubEnv('SECRET', secret);
  vi.resetModules();
  return import('./envelope');
}

function authenticatedEnvelope(
  plaintext: Buffer,
  context: EnvelopeContext,
): string {
  const domain =
    typeof context.domain === 'string'
      ? Buffer.from(context.domain)
      : Buffer.from(context.domain);
  const aad =
    typeof context.aad === 'string'
      ? Buffer.from(context.aad)
      : Buffer.from(context.aad);
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from('platform-secret'),
      Buffer.alloc(0),
      domain,
      32,
    ),
  );
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: 16,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

describe('encrypted envelopes', () => {
  it.each(['', 'plain text', '秘密 🔐 e\u0301'])(
    'round-trips arbitrary UTF-8 plaintext: %j',
    async (plaintext) => {
      const { decryptEnvelope, encryptEnvelope } = await loadEnvelopeModule();
      const envelope = encryptEnvelope(plaintext, CONTEXT);

      expect(decryptEnvelope(envelope, CONTEXT)).toBe(plaintext);
    },
  );

  it('uses a canonical v1 envelope with a fresh 12-byte IV', async () => {
    const { decryptEnvelope, encryptEnvelope } = await loadEnvelopeModule();
    const first = encryptEnvelope('same value', CONTEXT);
    const second = encryptEnvelope('same value', CONTEXT);
    const [version, encodedIv, encodedCiphertext, encodedAuthTag] =
      first.split('.');

    expect(first).not.toBe(second);
    expect(version).toBe('v1');
    expect(Buffer.from(encodedIv, 'base64url')).toHaveLength(12);
    expect(Buffer.from(encodedCiphertext, 'base64url')).toHaveLength(10);
    expect(Buffer.from(encodedAuthTag, 'base64url')).toHaveLength(16);
    expect(first).toMatch(
      /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/,
    );
    expect(decryptEnvelope(first, CONTEXT)).toBe('same value');
  });

  it('accepts the 64 KiB boundary and rejects larger plaintext', async () => {
    const { decryptEnvelope, encryptEnvelope } = await loadEnvelopeModule();
    const boundedContext = { ...CONTEXT, maxPlaintextBytes: 64 * 1024 };
    const boundary = 'a'.repeat(64 * 1024);
    const envelope = encryptEnvelope(boundary, boundedContext);

    expect(decryptEnvelope(envelope, boundedContext)).toBe(boundary);
    expect(() => encryptEnvelope(`${boundary}a`, boundedContext)).toThrow(
      'Invalid test secret: exceeds 65536 UTF-8 bytes',
    );
  });

  it('rejects oversized encoded ciphertext before decoding it', async () => {
    const { decryptEnvelope } = await loadEnvelopeModule();
    const envelope = [
      'v1',
      Buffer.alloc(12).toString('base64url'),
      Buffer.alloc(9).toString('base64url'),
      Buffer.alloc(16).toString('base64url'),
    ].join('.');

    expect(() =>
      decryptEnvelope(envelope, { ...CONTEXT, maxPlaintextBytes: 8 }),
    ).toThrow('Invalid test secret ciphertext: ciphertext exceeds');
  });

  it('supports an exact plaintext byte length', async () => {
    const { decryptEnvelope, encryptEnvelope } = await loadEnvelopeModule();
    const exactContext = { ...CONTEXT, expectedPlaintextBytes: 4 };
    const envelope = encryptEnvelope('test', exactContext);

    expect(decryptEnvelope(envelope, exactContext)).toBe('test');
    expect(() => encryptEnvelope('abc', exactContext)).toThrow(
      'Invalid test secret: expected 4 UTF-8 bytes',
    );
  });

  it('derives independent keys for each domain and authenticates caller AAD', async () => {
    const { decryptEnvelope, encryptEnvelope } = await loadEnvelopeModule();
    const envelope = encryptEnvelope('protected', CONTEXT);

    expect(() =>
      decryptEnvelope(envelope, { ...CONTEXT, domain: 'another-domain' }),
    ).toThrow('authentication failed or ciphertext is corrupted');
    expect(() =>
      decryptEnvelope(envelope, { ...CONTEXT, aad: 'another-owner' }),
    ).toThrow('authentication failed or ciphertext is corrupted');
  });

  it('does not decrypt with a different platform secret', async () => {
    const { encryptEnvelope } = await loadEnvelopeModule();
    const envelope = encryptEnvelope('protected', CONTEXT);
    const { decryptEnvelope } = await loadEnvelopeModule('other-secret');

    expect(() => decryptEnvelope(envelope, CONTEXT)).toThrow(
      'authentication failed or ciphertext is corrupted',
    );
  });

  it('rejects authenticated bytes that are not valid UTF-8', async () => {
    const { decryptEnvelope } = await loadEnvelopeModule();
    const envelope = authenticatedEnvelope(Buffer.from([0xc3, 0x28]), CONTEXT);

    expect(() => decryptEnvelope(envelope, CONTEXT)).toThrow(
      'authentication failed or ciphertext is corrupted',
    );
  });

  it('rejects tampering and non-canonical base64url', async () => {
    const { decryptEnvelope, encryptEnvelope } = await loadEnvelopeModule();
    const envelope = encryptEnvelope('protected', CONTEXT);
    const parts = envelope.split('.');
    const ciphertext = Buffer.from(parts[2], 'base64url');
    ciphertext[0] ^= 1;
    const tampered = [...parts];
    tampered[2] = ciphertext.toString('base64url');
    const padded = [...parts];
    padded[1] = `${padded[1]}=`;

    expect(() => decryptEnvelope(tampered.join('.'), CONTEXT)).toThrow(
      'authentication failed or ciphertext is corrupted',
    );
    expect(() => decryptEnvelope(padded.join('.'), CONTEXT)).toThrow(
      'Invalid test secret ciphertext: IV is not valid base64url',
    );
  });

  it.each([
    ['missing field', 'v1.part.part'],
    [
      'short IV',
      `v1.${Buffer.alloc(11).toString('base64url')}.part.${Buffer.alloc(16).toString('base64url')}`,
    ],
    [
      'short authentication tag',
      `v1.${Buffer.alloc(12).toString('base64url')}.part.${Buffer.alloc(15).toString('base64url')}`,
    ],
  ])('rejects a malformed envelope with a %s', async (_name, envelope) => {
    const { decryptEnvelope } = await loadEnvelopeModule();

    expect(() => decryptEnvelope(envelope, CONTEXT)).toThrow(
      'Invalid test secret ciphertext',
    );
  });

  it('rejects unknown envelope versions', async () => {
    const { decryptEnvelope } = await loadEnvelopeModule();

    expect(() =>
      decryptEnvelope(
        `v2.${Buffer.alloc(12).toString('base64url')}..${Buffer.alloc(16).toString('base64url')}`,
        CONTEXT,
      ),
    ).toThrow('Unsupported test secret ciphertext version: v2');
  });
});
