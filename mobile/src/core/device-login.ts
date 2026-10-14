import type { HatchApiClient } from './client';
import {
  boundedSignal,
  MobileError,
  throwIfAborted,
  validateToken,
  validateVerificationUrl,
} from './security';

export type DeviceCode = {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
};
export type DeviceLoginOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  onCode?: (code: DeviceCode) => void;
  openBrowser?: (url: string) => Promise<unknown>;
  /** Complete instance validation/activation before committing this sign-in. */
  validateSession?: (signal: AbortSignal) => Promise<void>;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MobileError('cancelled', 'Cancelled.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export class DeviceLogin {
  private controller: AbortController | null = null;
  constructor(private readonly client: HatchApiClient) {}
  cancel(): void {
    this.controller?.abort();
  }

  async start(options: DeviceLoginOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 30 * 60_000
    ) {
      throw new MobileError(
        'invalid_timeout',
        'Login timeout must be between zero and thirty minutes.',
      );
    }
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const bounded = boundedSignal(controller.signal, timeoutMs);
    const signal = bounded.signal;
    const deadline = Date.now() + timeoutMs;
    let savedToken: string | undefined;
    try {
      throwIfAborted(signal);
      const result = await this.client.deviceRequest(
        '/api/auth/device/code',
        { client_id: 'hatch-mobile' },
        signal,
        Math.min(15_000, timeoutMs),
      );
      const grant = result.data;
      if (
        !result.ok ||
        typeof grant.device_code !== 'string' ||
        !grant.device_code ||
        grant.device_code.length > 8192 ||
        typeof grant.user_code !== 'string' ||
        !/^[A-Za-z0-9-]{1,64}$/.test(grant.user_code) ||
        typeof grant.verification_uri_complete !== 'string' ||
        typeof grant.expires_in !== 'number' ||
        !Number.isFinite(grant.expires_in) ||
        grant.expires_in <= 0 ||
        (grant.interval !== undefined &&
          (typeof grant.interval !== 'number' ||
            !Number.isFinite(grant.interval) ||
            grant.interval <= 0))
      ) {
        throw new MobileError(
          'invalid_grant',
          'The instance returned an invalid login request.',
        );
      }
      const verificationUrl = validateVerificationUrl(
        this.client.origin,
        grant.verification_uri_complete,
        grant.user_code,
      );
      const expires = Math.min(deadline, Date.now() + grant.expires_in * 1000);
      let interval =
        typeof grant.interval === 'number'
          ? Math.max(1000, grant.interval * 1000)
          : 5000;
      options.onCode?.({
        userCode: grant.user_code,
        verificationUrl,
        expiresAt: expires,
      });
      throwIfAborted(signal);
      // Native browser promises resolve on dismissal. Poll immediately instead of
      // waiting for dismissal; the shown code also supports manual browser opening.
      if (options.openBrowser)
        void options.openBrowser(verificationUrl).catch(() => undefined);
      while (Date.now() < expires) {
        await sleep(Math.min(interval, expires - Date.now()), signal);
        throwIfAborted(signal);
        if (Date.now() >= expires) break;
        const poll = await this.client.deviceRequest(
          '/api/auth/device/token',
          {
            client_id: 'hatch-mobile',
            device_code: grant.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          },
          signal,
          Math.min(15_000, expires - Date.now()),
        );
        throwIfAborted(signal);
        if (poll.ok && typeof poll.data.access_token === 'string') {
          const token = validateToken(poll.data.access_token);
          await this.client.vault.set(this.client.origin, token);
          savedToken = token;
          throwIfAborted(signal);
          await options.validateSession?.(signal);
          throwIfAborted(signal);
          return;
        }
        if (poll.data.error === 'slow_down' || poll.status === 429) {
          interval += 5000;
          continue;
        }
        if (poll.data.error === 'authorization_pending') continue;
        if (poll.data.error === 'access_denied')
          throw new MobileError(
            'access_denied',
            'The login request was declined.',
          );
        if (poll.data.error === 'expired_token')
          throw new MobileError(
            'expired_token',
            'This login request expired. Start again.',
          );
        throw new MobileError(
          'device_login_failed',
          'Could not sign in. Start a new login request.',
        );
      }
      throw new MobileError(
        'expired_token',
        'This login request expired. Start again.',
      );
    } catch (error) {
      if (savedToken)
        await this.client.vault.removeIfMatch(this.client.origin, savedToken);
      if (signal.aborted) {
        throw new MobileError(
          controller.signal.aborted ? 'cancelled' : 'login_timeout',
          controller.signal.aborted
            ? 'Login cancelled.'
            : 'Login timed out. Start again.',
        );
      }
      if (error instanceof MobileError) throw error;
      throw new MobileError(
        'device_login_failed',
        'Could not sign in. Start a new login request.',
      );
    } finally {
      bounded.dispose();
      options.signal?.removeEventListener('abort', abort);
      if (this.controller === controller) this.controller = null;
    }
  }
}
