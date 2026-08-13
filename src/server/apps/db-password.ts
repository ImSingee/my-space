import { randomBytes } from 'node:crypto';
import {
  decryptEnvelope,
  encryptEnvelope,
  type EnvelopeContext,
} from '../crypto/envelope';

const PASSWORD_BYTES = 32;
const PASSWORD_PATTERN = /^[0-9a-f]{64}$/;

type PasswordContext = {
  label: string;
  domain: string;
  aadPrefix: string;
};

const APP_DB_PASSWORD_CONTEXT: PasswordContext = {
  label: 'app database',
  domain: 'my-space/app-db-password/aes-256-gcm/v1',
  aadPrefix: 'my-space/app-db-password',
};

const APP_DATA_DB_PASSWORD_CONTEXT: PasswordContext = {
  label: 'Data Table database',
  domain: 'my-space/app-data-db-password/aes-256-gcm/v1',
  aadPrefix: 'my-space/app-data-db-password',
};

function envelopeContext(
  context: PasswordContext,
  appId: string,
): EnvelopeContext {
  return {
    label: `${context.label} password`,
    domain: context.domain,
    aad: `${context.aadPrefix}/v1:${appId}`,
    expectedPlaintextBytes: PASSWORD_BYTES * 2,
    ciphertextPartLabel: 'encrypted password',
  };
}

function decryptionFailed(context: PasswordContext): Error {
  return new Error(
    `Unable to decrypt ${context.label} password: authentication failed or ciphertext is corrupted`,
  );
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

function encryptDbPassword(
  context: PasswordContext,
  appId: string,
  password: string,
): string {
  assertPassword(context, password);
  return encryptEnvelope(password, envelopeContext(context, appId));
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
  const password = decryptEnvelope(envelope, envelopeContext(context, appId));

  try {
    assertPassword(context, password);
  } catch {
    throw decryptionFailed(context);
  }
  return password;
}

/** Decrypt a stored password, rejecting any malformed or unauthentic value. */
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
