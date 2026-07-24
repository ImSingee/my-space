import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { getPlatformEnv } from '../../env';

const ENVELOPE_VERSION = 'v1';
const PASSWORD_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_INFO = Buffer.from(
  'my-space/app-db-password/aes-256-gcm/v1',
  'utf8',
);
const PASSWORD_PATTERN = /^[0-9a-f]{64}$/;

function encryptionKey(): Buffer {
  const { secret } = getPlatformEnv();
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.alloc(0),
      HKDF_INFO,
      KEY_BYTES,
    ),
  );
}

function aad(appId: string): Buffer {
  return Buffer.from(`my-space/app-db-password/${ENVELOPE_VERSION}:${appId}`);
}

function invalidCiphertext(reason: string): Error {
  return new Error(`Invalid app database password ciphertext: ${reason}`);
}

function decryptionFailed(): Error {
  return new Error(
    'Unable to decrypt app database password: authentication failed or ciphertext is corrupted',
  );
}

function decodeEnvelopePart(
  encoded: string,
  name: string,
  expectedBytes: number,
): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw invalidCiphertext(`${name} is not valid base64url`);
  }

  const decoded = Buffer.from(encoded, 'base64url');
  if (
    decoded.length !== expectedBytes ||
    decoded.toString('base64url') !== encoded
  ) {
    throw invalidCiphertext(`${name} has an invalid length or encoding`);
  }
  return decoded;
}

function assertPassword(password: string): void {
  if (
    password.length !== PASSWORD_BYTES * 2 ||
    !PASSWORD_PATTERN.test(password)
  ) {
    throw new Error(
      'Invalid app database password: expected 64 lowercase hexadecimal characters',
    );
  }
}

/** Generate a URL- and SQL-literal-safe password with 256 bits of entropy. */
export function generateAppDbPassword(): string {
  return randomBytes(PASSWORD_BYTES).toString('hex');
}

/** Preserve the password derivation used before encrypted storage existed. */
export function legacyAppDbPassword(dbName: string): string {
  const { secret } = getPlatformEnv();
  return createHmac('sha256', secret)
    .update(`app-db-password:${dbName}`)
    .digest('hex');
}

/** Encrypt a generated app database password for storage on the app row. */
export function encryptAppDbPassword(appId: string, password: string): string {
  assertPassword(password);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad(appId));
  const ciphertext = Buffer.concat([
    cipher.update(password, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    authTag.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a stored password. Authentication failures are terminal: callers
 * must never treat them as a signal to fall back to the legacy derivation.
 */
export function decryptAppDbPassword(appId: string, envelope: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 4) {
    throw invalidCiphertext('expected four envelope fields');
  }

  const [version, encodedIv, encodedCiphertext, encodedAuthTag] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new Error(
      `Unsupported app database password ciphertext version: ${version || '(missing)'}`,
    );
  }

  const iv = decodeEnvelopePart(encodedIv, 'IV', IV_BYTES);
  const ciphertext = decodeEnvelopePart(
    encodedCiphertext,
    'encrypted password',
    PASSWORD_BYTES * 2,
  );
  const authTag = decodeEnvelopePart(
    encodedAuthTag,
    'authentication tag',
    AUTH_TAG_BYTES,
  );

  const key = encryptionKey();
  let password: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad(appId));
    decipher.setAuthTag(authTag);
    password = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw decryptionFailed();
  }

  try {
    assertPassword(password);
  } catch {
    throw decryptionFailed();
  }
  return password;
}
