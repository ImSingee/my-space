import { isUtf8 } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { getPlatformEnv } from '../../env';

const ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

type EnvelopeBytes = string | Uint8Array;

export type EnvelopeContext = Readonly<{
  /** Safe, non-secret name used in validation and decryption errors. */
  label: string;
  /** HKDF info that separates this encrypted-value domain from every other. */
  domain: EnvelopeBytes;
  /** Authenticated context that binds a ciphertext to its owner and purpose. */
  aad: EnvelopeBytes;
  /** Require an exact UTF-8 plaintext length, when the value has a fixed size. */
  expectedPlaintextBytes?: number;
  /** Reject larger values before allocating a decoded ciphertext buffer. */
  maxPlaintextBytes?: number;
  /** Optional name for the ciphertext field in validation errors. */
  ciphertextPartLabel?: string;
}>;

function asBuffer(value: EnvelopeBytes): Buffer {
  return typeof value === 'string'
    ? Buffer.from(value, 'utf8')
    : Buffer.from(value);
}

function validateByteCount(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function validateContext(context: EnvelopeContext): void {
  validateByteCount('expectedPlaintextBytes', context.expectedPlaintextBytes);
  validateByteCount('maxPlaintextBytes', context.maxPlaintextBytes);

  if (
    context.expectedPlaintextBytes !== undefined &&
    context.maxPlaintextBytes !== undefined &&
    context.expectedPlaintextBytes > context.maxPlaintextBytes
  ) {
    throw new Error('expectedPlaintextBytes must not exceed maxPlaintextBytes');
  }
}

function encryptionKey(context: EnvelopeContext): Buffer {
  const { secret } = getPlatformEnv();
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.alloc(0),
      asBuffer(context.domain),
      KEY_BYTES,
    ),
  );
}

function invalidCiphertext(context: EnvelopeContext, reason: string): Error {
  return new Error(`Invalid ${context.label} ciphertext: ${reason}`);
}

function decryptionFailed(context: EnvelopeContext): Error {
  return new Error(
    `Unable to decrypt ${context.label}: authentication failed or ciphertext is corrupted`,
  );
}

function base64urlLength(byteLength: number): number {
  const paddedLength = Math.ceil(byteLength / 3) * 4;
  const remainder = byteLength % 3;
  return paddedLength - (remainder === 0 ? 0 : 3 - remainder);
}

function decodeEnvelopePart(
  context: EnvelopeContext,
  encoded: string,
  name: string,
  limits: Readonly<{ expectedBytes?: number; maxBytes?: number }>,
): Buffer {
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw invalidCiphertext(context, `${name} is not valid base64url`);
  }

  if (
    limits.expectedBytes !== undefined &&
    encoded.length !== base64urlLength(limits.expectedBytes)
  ) {
    throw invalidCiphertext(
      context,
      `${name} has an invalid length or encoding`,
    );
  }

  if (
    limits.maxBytes !== undefined &&
    encoded.length > base64urlLength(limits.maxBytes)
  ) {
    throw invalidCiphertext(context, `${name} exceeds the maximum length`);
  }

  const decoded = Buffer.from(encoded, 'base64url');
  if (
    (limits.expectedBytes !== undefined &&
      decoded.length !== limits.expectedBytes) ||
    (limits.maxBytes !== undefined && decoded.length > limits.maxBytes) ||
    decoded.toString('base64url') !== encoded
  ) {
    throw invalidCiphertext(
      context,
      `${name} has an invalid length or encoding`,
    );
  }
  return decoded;
}

function assertPlaintextLength(
  context: EnvelopeContext,
  plaintextBytes: number,
): void {
  if (
    context.expectedPlaintextBytes !== undefined &&
    plaintextBytes !== context.expectedPlaintextBytes
  ) {
    throw new Error(
      `Invalid ${context.label}: expected ${context.expectedPlaintextBytes} UTF-8 bytes`,
    );
  }
  if (
    context.maxPlaintextBytes !== undefined &&
    plaintextBytes > context.maxPlaintextBytes
  ) {
    throw new Error(
      `Invalid ${context.label}: exceeds ${context.maxPlaintextBytes} UTF-8 bytes`,
    );
  }
}

/** Encrypt a UTF-8 string using a versioned AES-256-GCM envelope. */
export function encryptEnvelope(
  plaintext: string,
  context: EnvelopeContext,
): string {
  validateContext(context);
  assertPlaintextLength(context, Buffer.byteLength(plaintext, 'utf8'));
  const plaintextBytes = Buffer.from(plaintext, 'utf8');

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(context), iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(asBuffer(context.aad));
  const ciphertext = Buffer.concat([
    cipher.update(plaintextBytes),
    cipher.final(),
  ]);

  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a UTF-8 string. Every malformed or unauthenticated value is terminal;
 * callers must not use decryption failure as a signal to try another value.
 */
export function decryptEnvelope(
  envelope: string,
  context: EnvelopeContext,
): string {
  validateContext(context);
  const parts = envelope.split('.');
  if (parts.length !== 4) {
    throw invalidCiphertext(context, 'expected four envelope fields');
  }

  const [version, encodedIv, encodedCiphertext, encodedAuthTag] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new Error(
      `Unsupported ${context.label} ciphertext version: ${version || '(missing)'}`,
    );
  }

  const iv = decodeEnvelopePart(context, encodedIv, 'IV', {
    expectedBytes: IV_BYTES,
  });
  const ciphertext = decodeEnvelopePart(
    context,
    encodedCiphertext,
    context.ciphertextPartLabel ?? 'ciphertext',
    {
      expectedBytes: context.expectedPlaintextBytes,
      maxBytes: context.maxPlaintextBytes,
    },
  );
  const authTag = decodeEnvelopePart(
    context,
    encodedAuthTag,
    'authentication tag',
    { expectedBytes: AUTH_TAG_BYTES },
  );

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(context),
      iv,
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAAD(asBuffer(context.aad));
    decipher.setAuthTag(authTag);
    const plaintextBytes = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    if (!isUtf8(plaintextBytes)) throw new Error('Invalid UTF-8');
    return plaintextBytes.toString('utf8');
  } catch {
    throw decryptionFailed(context);
  }
}
