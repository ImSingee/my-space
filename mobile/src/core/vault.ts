import {
  canonicalizeInstanceUrl,
  MobileError,
  validateToken,
} from './security';
import type { InstanceUrlOptions } from './security';

/** Implement with SecureStore on native. Never use AsyncStorage for this adapter. */
export interface SecurePersistence {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export type Sha256 = (value: string) => Promise<string>;

export class InstanceVault {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(
    private readonly storage: SecurePersistence,
    private readonly sha256: Sha256,
    private readonly options: InstanceUrlOptions = {},
  ) {}

  private async key(origin: string): Promise<string> {
    const digest = await this.sha256(
      canonicalizeInstanceUrl(origin, this.options),
    );
    if (!/^[a-f0-9]{64}$/i.test(digest)) {
      throw new MobileError(
        'invalid_digest',
        'Secure instance key generation failed.',
      );
    }
    return `hatch.mobile.token.v1.${digest.toLowerCase()}`;
  }

  /** Serialize mutations so a late 401 cannot remove a freshly rotated token. */
  private async exclusive<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    this.pending.set(key, result);
    try {
      return await result;
    } finally {
      if (this.pending.get(key) === result) this.pending.delete(key);
    }
  }

  async get(origin: string): Promise<string | null> {
    const key = await this.key(origin);
    return this.exclusive(key, async () => {
      const token = await this.storage.get(key);
      return token === null ? null : validateToken(token);
    });
  }
  async set(origin: string, token: string): Promise<void> {
    const value = validateToken(token);
    const key = await this.key(origin);
    await this.exclusive(key, () => this.storage.set(key, value));
  }
  async remove(origin: string): Promise<void> {
    const key = await this.key(origin);
    await this.exclusive(key, () => this.storage.remove(key));
  }
  async removeIfMatch(origin: string, token: string): Promise<boolean> {
    const key = await this.key(origin);
    return this.exclusive(key, async () => {
      if ((await this.storage.get(key)) !== token) return false;
      await this.storage.remove(key);
      return true;
    });
  }
}
