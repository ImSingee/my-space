/** Credential minting and at-rest encryption for notification destinations. */
import { createHash, randomBytes } from 'node:crypto';
import { decryptEnvelope, encryptEnvelope } from '../crypto/envelope';

const WEBHOOK_SECRET_DOMAIN =
  'my-space/notification-webhook-secret/aes-256-gcm/v1';
const DEVICE_KEY_DOMAIN = 'my-space/notification-device-key/aes-256-gcm/v1';
const AAD_DOMAIN = 'my-space/notification-destination';

/** Raw bytes of a device end-to-end key (AES-256-GCM). */
export const DEVICE_KEY_BYTES = 32;

/** Channel push token shown once; only its sha256 is stored. */
export function mintChannelToken(): string {
  return `hnc_${randomBytes(32).toString('base64url')}`;
}

/** Webhook signing secret shown once; stored encrypted because signing needs it. */
export function mintWebhookSecret(): string {
  return `hnw_${randomBytes(32).toString('base64url')}`;
}

export function hashChannelToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function context(
  destinationId: string,
  purpose: 'webhook-secret' | 'device-key',
  maxPlaintextBytes: number,
) {
  return {
    label:
      purpose === 'webhook-secret'
        ? 'notification webhook secret'
        : 'notification device key',
    domain:
      purpose === 'webhook-secret' ? WEBHOOK_SECRET_DOMAIN : DEVICE_KEY_DOMAIN,
    aad: JSON.stringify([AAD_DOMAIN, 'v1', purpose, destinationId]),
    maxPlaintextBytes,
  } as const;
}

export function encryptWebhookSecret(destinationId: string, secret: string) {
  return encryptEnvelope(secret, context(destinationId, 'webhook-secret', 256));
}

export function decryptWebhookSecret(destinationId: string, envelope: string) {
  return decryptEnvelope(
    envelope,
    context(destinationId, 'webhook-secret', 256),
  );
}

/** Device keys travel and rest as base64url of exactly 32 bytes. */
export function encryptDeviceKey(destinationId: string, keyBase64url: string) {
  return encryptEnvelope(
    keyBase64url,
    context(destinationId, 'device-key', 64),
  );
}

export function decryptDeviceKey(destinationId: string, envelope: string) {
  return Buffer.from(
    decryptEnvelope(envelope, context(destinationId, 'device-key', 64)),
    'base64url',
  );
}

export function isValidDeviceKey(keyBase64url: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(keyBase64url)) return false;
  const bytes = Buffer.from(keyBase64url, 'base64url');
  return (
    bytes.length === DEVICE_KEY_BYTES &&
    bytes.toString('base64url') === keyBase64url
  );
}
