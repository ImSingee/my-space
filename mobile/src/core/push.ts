import { canonicalizeInstanceUrl, MobileError } from './security';
import type { InstanceUrlOptions } from './security';
import { externalUrl } from './surface-navigation';
import type { PushRegistration } from './types';

/** What this phone remembers about push for one instance (app-private). */
export type PushRecord = {
  /** Identifies the key in the shared keychain; echoed by every push. */
  kid: string;
  /** 32-byte AES-256-GCM key, base64url without padding. */
  key: string;
};

export type PushApi = {
  registerPushDevice(input: PushRegistration): Promise<void>;
  unregisterPushDevice(): Promise<void>;
};

/** Native capabilities, injected so the registration rules stay testable. */
export type PushPlatform = {
  environment: 'sandbox' | 'production';
  deviceName(): string;
  /** Resolve whether alerts are allowed, asking only when `prompt` is true. */
  permission(prompt: boolean): Promise<boolean>;
  /** Native APNs device token as hex. */
  apnsToken(): Promise<string>;
  randomBytes(count: number): Uint8Array;
  /** Keychain group readable by the Notification Service Extension. */
  sharedKeys: {
    set(kid: string, key: string): Promise<void>;
    has(kid: string): Promise<boolean>;
    remove(kid: string): Promise<void>;
    /** Whether the key `kid` signed these tap fields (see the extension). */
    verifyTap(
      kid: string,
      mac: string,
      fields: PushTapFields,
    ): Promise<boolean>;
  };
  /** App-private per-instance records. */
  records: {
    get(origin: string): Promise<PushRecord | null>;
    set(origin: string, record: PushRecord): Promise<void>;
    remove(origin: string): Promise<void>;
  };
};

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** RFC 4648 base64url without padding (Hermes has no Buffer). */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += ALPHABET[c & 63];
  }
  return out;
}

export function parsePushRecord(raw: string | null): PushRecord | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as PushRecord).kid === 'string' &&
      /^[A-Za-z0-9_-]{8,64}$/.test((value as PushRecord).kid) &&
      typeof (value as PushRecord).key === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test((value as PushRecord).key)
    )
      return { kid: (value as PushRecord).kid, key: (value as PushRecord).key };
  } catch {
    // Corrupt records are treated as "push off" and rewritten on enable.
  }
  return null;
}

/**
 * Per-instance push registration. One random key per (phone, instance) is
 * shared only with that instance over its authenticated session and with the
 * extension through the keychain, so a push that does not decrypt with it is
 * shown as unverified.
 */
export class PushRegistrar {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(
    private readonly platform: PushPlatform,
    private readonly options: InstanceUrlOptions = {},
  ) {}

  /** Serialize operations per instance so enable/refresh/disable never interleave. */
  private exclusive<T>(
    origin: string,
    operation: (key: string) => Promise<T>,
  ): Promise<T> {
    const key = canonicalizeInstanceUrl(origin, this.options);
    const previous = this.pending.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => operation(key));
    this.pending.set(key, result);
    void result
      .catch(() => undefined)
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      });
    return result;
  }

  enabled(origin: string): Promise<boolean> {
    return this.platform.records
      .get(canonicalizeInstanceUrl(origin, this.options))
      .then(Boolean);
  }

  private async register(
    api: PushApi,
    record: PushRecord,
    suppliedToken?: string,
  ) {
    if (!(await this.platform.sharedKeys.has(record.kid)))
      await this.platform.sharedKeys.set(record.kid, record.key);
    const token = (
      suppliedToken ?? (await this.platform.apnsToken())
    ).toLowerCase();
    if (!/^[0-9a-f]{16,200}$/.test(token))
      throw new MobileError(
        'push_unavailable',
        'This phone did not receive a valid push token.',
      );
    await api.registerPushDevice({
      name: this.platform.deviceName().slice(0, 80) || 'iPhone',
      apnsToken: token,
      apnsEnvironment: this.platform.environment,
      e2eKeyId: record.kid,
      e2eKey: record.key,
    });
  }

  /** Turn push on for an instance; returns false when alerts are denied. */
  enable(origin: string, api: PushApi): Promise<boolean> {
    return this.exclusive(origin, async (key) => {
      if (!(await this.platform.permission(true))) return false;
      const record = (await this.platform.records.get(key)) ?? {
        kid: base64url(this.platform.randomBytes(16)),
        key: base64url(this.platform.randomBytes(32)),
      };
      await this.platform.records.set(key, record);
      await this.register(api, record);
      return true;
    });
  }

  /**
   * Re-send the token for an instance that has push on. Never prompts; does
   * nothing when push is off. A token-rotation listener passes the token it
   * received: requesting one again from inside that listener re-triggers it.
   */
  refresh(origin: string, api: PushApi, token?: string): Promise<void> {
    return this.exclusive(origin, async (key) => {
      const record = await this.platform.records.get(key);
      if (!record || !(await this.platform.permission(false))) return;
      await this.register(api, record, token);
    });
  }

  /**
   * Turn push off: forget local keys first so no later push can decrypt, then
   * tell the instance, which disables the device but keeps its routing (best
   * effort when signing out — the server drops the device with the session).
   */
  disable(origin: string, api: PushApi | null): Promise<void> {
    return this.exclusive(origin, async (key) => {
      const record = await this.platform.records.get(key);
      if (record) await this.platform.sharedKeys.remove(record.kid);
      await this.platform.records.remove(key);
      if (api) await api.unregisterPushDevice();
    });
  }
}

/** What tapping a Hatch push opens. */
export type PushTap = {
  origin: string;
  notificationId: string;
  /**
   * The sender asked for this URL to open on tap instead of the notification.
   * Only a URL the shared external-link policy lets leave the app, and only
   * once `verifiedTapUrl` confirms the extension decrypted it.
   */
  autoOpen: {
    url: string;
    /** Signed fields exactly as the extension wrote them. */
    signed: PushTapFields;
    kid: string;
    mac: string;
  } | null;
};

export type PushTapFields = { origin: string; id: string; url: string };

const NO_HANDOFF = { ticket: '', completionUrl: '' };

const text = (value: unknown) => (typeof value === 'string' ? value : null);

/**
 * Read the tap payload the Notification Service Extension writes after
 * decrypting. A push the extension never saw can carry the same fields, so
 * opening its URL waits for `verifiedTapUrl`; everything else only opens the
 * notification inside the app.
 */
export function pushTap(
  data: unknown,
  options: InstanceUrlOptions = {},
): PushTap | null {
  if (!data || typeof data !== 'object') return null;
  const fields = data as Record<string, unknown>;
  const rawOrigin = text(fields.hatchOrigin);
  const notificationId = text(fields.hatchNotificationId);
  if (!rawOrigin || !notificationId) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(notificationId)) return null;
  let origin: string;
  try {
    origin = canonicalizeInstanceUrl(rawOrigin, options);
  } catch {
    return null;
  }
  const rawUrl = text(fields.hatchUrl);
  const kid = text(fields.hatchKid);
  const mac = text(fields.hatchTapMac);
  const url =
    fields.hatchAutoOpenUrl === true && rawUrl && kid && mac
      ? externalUrl(rawUrl, { origin, handoff: NO_HANDOFF })
      : null;
  return {
    origin,
    notificationId,
    autoOpen:
      url && kid && mac && rawUrl
        ? {
            url,
            signed: { origin: rawOrigin, id: notificationId, url: rawUrl },
            kid,
            mac,
          }
        : null,
  };
}

/**
 * The URL a tap opens, once the phone confirms that its own key for that
 * instance signed the tap fields: only the extension, after decrypting the
 * sender's push, can produce that signature.
 */
export async function verifiedTapUrl(
  tap: PushTap,
  platform: Pick<PushPlatform, 'records' | 'sharedKeys'>,
): Promise<string | null> {
  const { autoOpen } = tap;
  if (!autoOpen) return null;
  try {
    const record = await platform.records.get(tap.origin);
    if (record?.kid !== autoOpen.kid) return null;
    const valid = await platform.sharedKeys.verifyTap(
      autoOpen.kid,
      autoOpen.mac,
      autoOpen.signed,
    );
    return valid ? autoOpen.url : null;
  } catch {
    return null;
  }
}
