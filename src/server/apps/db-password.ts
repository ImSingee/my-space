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
const PASSWORD_PATTERN = /^[0-9a-f]{64}$/;

type PasswordContext = {
  label: string;
  hkdfInfo: Buffer;
  aadPrefix: string;
};

const APP_DB_PASSWORD_CONTEXT: PasswordContext = {
  label: 'app database',
  hkdfInfo: Buffer.from('my-space/app-db-password/aes-256-gcm/v1', 'utf8'),
  aadPrefix: 'my-space/app-db-password',
};

const APP_DATA_DB_PASSWORD_CONTEXT: PasswordContext = {
  label: 'Data Table database',
  hkdfInfo: Buffer.from('my-space/app-data-db-password/aes-256-gcm/v1', 'utf8'),
  aadPrefix: 'my-space/app-data-db-password',
};

function encryptionKey(context: PasswordContext): Buffer {
  const { secret } = getPlatformEnv();
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.alloc(0),
      context.hkdfInfo,
      KEY_BYTES,
    ),
  );
}

function aad(context: PasswordContext, appId: string): Buffer {
  return Buffer.from(`${context.aadPrefix}/${ENVELOPE_VERSION}:${appId}`);
}

function invalidCiphertext(context: PasswordContext, reason: string): Error {
  return new Error(`Invalid ${context.label} password ciphertext: ${reason}`);
}

function decryptionFailed(context: PasswordContext): Error {
  return new Error(
    `Unable to decrypt ${context.label} password: authentication failed or ciphertext is corrupted`,
  );
}

function decodeEnvelopePart(
  context: PasswordContext,
  encoded: string,
  name: string,
  expectedBytes: number,
): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw invalidCiphertext(context, `${name} is not valid base64url`);
  }

  const decoded = Buffer.from(encoded, 'base64url');
  if (
    decoded.length !== expectedBytes ||
    decoded.toString('base64url') !== encoded
  ) {
    throw invalidCiphertext(
      context,
      `${name} has an invalid length or encoding`,
    );
  }
  return decoded;
}

function assertPassword(context: PasswordContext, password: string): void {
  if (
    password.length !== PASSWORD_BYTES * 2 ||
    !PASSWORD_PATTERN.test(password)
  ) {
    throw new Error(
      `Invalid ${context.label} password: expected 64 lowercase hexadecimal characters`,
    );
  }
}

function generateDbPassword(): string {
  return randomBytes(PASSWORD_BYTES).toString('hex');
}

/** Generate a URL- and SQL-literal-safe password with 256 bits of entropy. */
export function generateAppDbPassword(): string {
  return generateDbPassword();
}

/** Generate a random password for a platform-managed Data Table database. */
export function generateAppDataDbPassword(): string {
  return generateDbPassword();
}

/** Preserve the password derivation used before encrypted storage existed. */
export function legacyAppDbPassword(dbName: string): string {
  const { secret } = getPlatformEnv();
  return createHmac('sha256', secret)
    .update(`app-db-password:${dbName}`)
    .digest('hex');
}

function encryptDbPassword(
  context: PasswordContext,
  appId: string,
  password: string,
): string {
  assertPassword(context, password);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(context), iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad(context, appId));
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

/** Encrypt a generated app database password for storage on the app row. */
export function encryptAppDbPassword(appId: string, password: string): string {
  return encryptDbPassword(APP_DB_PASSWORD_CONTEXT, appId, password);
}

/** Encrypt a generated Data Table database password for storage on the app row. */
export function encryptAppDataDbPassword(
  appId: string,
  password: string,
): string {
  return encryptDbPassword(APP_DATA_DB_PASSWORD_CONTEXT, appId, password);
}

function decryptDbPassword(
  context: PasswordContext,
  appId: string,
  envelope: string,
): string {
  const parts = envelope.split('.');
  if (parts.length !== 4) {
    throw invalidCiphertext(context, 'expected four envelope fields');
  }

  const [version, encodedIv, encodedCiphertext, encodedAuthTag] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new Error(
      `Unsupported ${context.label} password ciphertext version: ${version || '(missing)'}`,
    );
  }

  const iv = decodeEnvelopePart(context, encodedIv, 'IV', IV_BYTES);
  const ciphertext = decodeEnvelopePart(
    context,
    encodedCiphertext,
    'encrypted password',
    PASSWORD_BYTES * 2,
  );
  const authTag = decodeEnvelopePart(
    context,
    encodedAuthTag,
    'authentication tag',
    AUTH_TAG_BYTES,
  );

  const key = encryptionKey(context);
  let password: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad(context, appId));
    decipher.setAuthTag(authTag);
    password = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw decryptionFailed(context);
  }

  try {
    assertPassword(context, password);
  } catch {
    throw decryptionFailed(context);
  }
  return password;
}

/**
 * Decrypt a stored password. Authentication failures are terminal: callers
 * must never treat them as a signal to fall back to the legacy derivation.
 */
export function decryptAppDbPassword(appId: string, envelope: string): string {
  return decryptDbPassword(APP_DB_PASSWORD_CONTEXT, appId, envelope);
}

/** Decrypt the stored password for a platform-managed Data Table database. */
export function decryptAppDataDbPassword(
  appId: string,
  envelope: string,
): string {
  return decryptDbPassword(APP_DATA_DB_PASSWORD_CONTEXT, appId, envelope);
}
