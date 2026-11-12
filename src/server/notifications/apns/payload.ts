/**
 * End-to-end encrypted APNs payloads.
 *
 * Apple only sees a generic placeholder alert plus ciphertext. The iOS
 * Notification Service Extension decrypts `h.c` with the per-instance device
 * key (AES-256-GCM, CryptoKit "combined" layout: nonce ‖ ciphertext ‖ tag),
 * authenticating `h.kid` as associated data, and replaces the alert.
 */
import { createCipheriv, randomBytes } from 'node:crypto';

export const APNS_MAX_PAYLOAD_BYTES = 4096;
export const PUSH_PAYLOAD_VERSION = 1;
export const PLACEHOLDER_TITLE = 'Hatch';
export const PLACEHOLDER_BODY = 'New notification';

/** Decrypted content the extension renders and the app opens on tap. */
export type PushPlaintext = {
  v: 1;
  /** Notification id. */
  id: string;
  /** Instance origin, so the app opens the right signed-in instance. */
  o: string;
  t: string;
  b: string | null;
  /** Source display name. */
  s: string;
  /** Kind display name. */
  k: string;
  /** Thread grouping key (source id). */
  g: string;
  u: string | null;
  at: string;
};

export function pushAssociatedData(keyId: string): Buffer {
  return Buffer.from(`hatch-push-v${PUSH_PAYLOAD_VERSION}|${keyId}`, 'utf8');
}

function seal(key: Buffer, keyId: string, plaintext: PushPlaintext): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(pushAssociatedData(keyId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString(
    'base64',
  );
}

function encode(key: Buffer, keyId: string, plaintext: PushPlaintext): string {
  return JSON.stringify({
    aps: {
      alert: { title: PLACEHOLDER_TITLE, body: PLACEHOLDER_BODY },
      sound: 'default',
      'mutable-content': 1,
    },
    h: { v: PUSH_PAYLOAD_VERSION, kid: keyId, c: seal(key, keyId, plaintext) },
  });
}

function fits(payload: string): boolean {
  return Buffer.byteLength(payload, 'utf8') <= APNS_MAX_PAYLOAD_BYTES;
}

/** Longest prefix of `text` (in code points) whose payload still fits. */
function longestFitting(
  text: string,
  render: (candidate: string) => string,
): string | null {
  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  // Invariant: a prefix of `low` characters fits (0 is checked by the caller).
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(render(`${chars.slice(0, mid).join('')}…`))) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? `${chars.slice(0, low).join('')}…` : null;
}

/**
 * Build the APNs JSON body, shortening the body text (then dropping the URL,
 * then shortening the title) until the payload fits Apple's 4 KiB limit. The
 * full text stays available in the app's notification detail.
 */
export function buildEncryptedApnsPayload(
  key: Buffer,
  keyId: string,
  plaintext: PushPlaintext,
): string {
  const render = (content: PushPlaintext) => encode(key, keyId, content);
  const full = render(plaintext);
  if (fits(full)) return full;

  let current: PushPlaintext = { ...plaintext, b: null };
  if (plaintext.b && fits(render(current))) {
    const body = longestFitting(plaintext.b, (b) => render({ ...current, b }));
    return render({ ...current, b: body });
  }
  current = { ...current, u: null };
  if (fits(render(current))) return render(current);
  const title = longestFitting(current.t, (t) => render({ ...current, t }));
  if (!title) throw new Error('Notification cannot fit into an APNs payload.');
  return render({ ...current, t: title });
}
