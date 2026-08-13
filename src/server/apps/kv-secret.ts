import { decryptEnvelope, encryptEnvelope } from '../crypto/envelope';

const KV_SECRET_DOMAIN = 'my-space/app-kv-secret/aes-256-gcm/v1';
const KV_SECRET_AAD_DOMAIN = 'my-space/app-kv-secret';

function context(appId: string, key: string, maxPlaintextBytes: number) {
  return {
    label: 'KV secret',
    domain: KV_SECRET_DOMAIN,
    // A JSON tuple is unambiguous even when an id or key contains punctuation.
    aad: JSON.stringify([KV_SECRET_AAD_DOMAIN, 'v1', appId, key]),
    maxPlaintextBytes,
    ciphertextPartLabel: 'encrypted value',
  } as const;
}

/** Encrypt a KV secret in a domain bound to its app and normalized key. */
export function encryptKvSecret(
  appId: string,
  key: string,
  value: string,
  maxPlaintextBytes: number,
): string {
  return encryptEnvelope(value, context(appId, key, maxPlaintextBytes));
}

/** Decrypt a KV secret; moving its envelope to another app/key fails closed. */
export function decryptKvSecret(
  appId: string,
  key: string,
  envelope: string,
  maxPlaintextBytes: number,
): string {
  return decryptEnvelope(envelope, context(appId, key, maxPlaintextBytes));
}
