import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { authClient } from './client';
import { authenticatePasskey } from './passkey-credential';
import {
  isPasskeyCancellation,
  type PasskeyClientError,
} from './passkey-browser';

// Better Auth 1.7's challenge and cookie expire after five minutes. Leave a
// full minute for scheduling delays and the options round trip.
const RENEW_AFTER_MS = 4 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

class PasskeyRequestTimeoutError extends Error {
  readonly code = 'PASSKEY_REQUEST_TIMEOUT';
  readonly status = 408;

  constructor() {
    super('Passkey sign-in request timed out. Please try again.');
    this.name = 'PasskeyRequestTimeoutError';
  }
}

type Attempt = {
  controller: AbortController;
  conditional: boolean;
  startedAt: number;
  renewable: boolean;
  timer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
};

export class PasskeyAuthentication {
  private current?: Attempt;
  private autofill = false;
  private explicit = false;
  private stopped = false;
  private authenticated = false;
  private recoverableAutofill = false;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly onSuccess: () => Promise<void>,
    private readonly onError: (error: PasskeyClientError) => void,
  ) {}

  enableAutofill() {
    this.autofill = true;
    this.startAutofill();
  }

  // Timers can be throttled in sleeping tabs. Restore freshness on focus too.
  refreshAutofill() {
    const attempt = this.current;
    if (!attempt && this.recoverableAutofill) {
      this.startAutofill();
      return;
    }
    if (
      attempt?.conditional &&
      attempt.renewable &&
      Date.now() - attempt.startedAt >= RENEW_AFTER_MS
    ) {
      void this.renew(attempt);
    }
  }

  async signIn() {
    if (this.explicit || this.stopped || this.authenticated) return;
    this.explicit = true;
    this.clearRetry();
    try {
      await this.cancelCurrent();
      if (!this.stopped) await this.start(false);
    } finally {
      this.explicit = false;
      this.startAutofill();
    }
  }

  dispose() {
    this.stopped = true;
    this.clearRetry();
    void this.cancelCurrent();
  }

  private clearRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private startAutofill() {
    if (
      this.autofill &&
      !this.stopped &&
      !this.authenticated &&
      !this.explicit &&
      !this.current
    ) {
      void this.start(true);
    }
  }

  private async cancelCurrent() {
    const attempt = this.current;
    if (!attempt) return;
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    // Serialize cookie-writing HTTP requests as well as native ceremonies.
    // A late response must not replace the next attempt's challenge.
    await attempt.done;
    if (this.current === attempt) this.current = undefined;
  }

  private async renew(attempt: Attempt) {
    if (
      this.current !== attempt ||
      !attempt.renewable ||
      attempt.controller.signal.aborted
    )
      return;
    await this.cancelCurrent();
    this.startAutofill();
  }

  private start(conditional: boolean) {
    this.recoverableAutofill = false;
    const attempt: Attempt = {
      controller: new AbortController(),
      conditional,
      startedAt: Date.now(),
      renewable: conditional,
      done: Promise.resolve(),
    };
    this.current = attempt;
    if (conditional) {
      attempt.timer = setTimeout(
        () => void this.renew(attempt),
        RENEW_AFTER_MS,
      );
    }
    attempt.done = this.run(attempt);
    return attempt.done;
  }

  private isCurrent(attempt: Attempt) {
    return (
      !this.stopped &&
      this.current === attempt &&
      !attempt.controller.signal.aborted
    );
  }

  private async run(attempt: Attempt) {
    let expired = false;
    let requestingOptions = true;
    try {
      const options = await this.fetch<PublicKeyCredentialRequestOptionsJSON>(
        attempt,
        '/passkey/generate-authenticate-options',
        { method: 'GET' },
      );
      if (!this.isCurrent(attempt)) return;
      if (options.error) throw options.error;
      if (!options.data) throw new Error('Passkey options were not returned.');
      requestingOptions = false;

      const response = await authenticatePasskey(
        options.data,
        attempt.conditional,
        attempt.controller.signal,
      );
      if (!this.isCurrent(attempt)) return;
      attempt.renewable = false;
      // Let verification finish before another options request overwrites its
      // challenge cookie, even if the renewal timer would otherwise fire.
      clearTimeout(attempt.timer);
      const { clientExtensionResults: _extensions, ...assertion } = response;
      const result = await this.fetch(
        attempt,
        '/passkey/verify-authentication',
        {
          method: 'POST',
          body: { response: assertion },
        },
      );
      if (!this.isCurrent(attempt)) return;
      if (result.error) throw result.error;
      this.authenticated = true;
      authClient.$store.notify('$sessionSignal');
      authClient.$store.notify('$listPasskeys');
      await this.onSuccess();
    } catch (error) {
      if (!this.isCurrent(attempt)) return;
      if (attempt.conditional && requestingOptions) {
        const status = (error as { status?: number } | null)?.status;
        // Only transient options failures can resume on focus/connectivity.
        // HTTP timeouts carry status 408; native cancellation never enters
        // this branch because the options request has already completed.
        this.recoverableAutofill =
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === 'NetworkError') ||
          status === 408 ||
          status === 429 ||
          (typeof status === 'number' && status >= 500 && status < 600);
      }
      if (
        error instanceof DOMException &&
        (error.name === 'AbortError' || error.name === 'NotAllowedError')
      )
        return;
      const failure = error as PasskeyClientError;
      expired = failure.code === 'CHALLENGE_NOT_FOUND';
      if (!attempt.conditional && !isPasskeyCancellation(failure)) {
        this.onError(failure);
      }
    } finally {
      clearTimeout(attempt.timer);
      if (this.current === attempt) {
        this.current = undefined;
        if (attempt.conditional && expired && !this.stopped) {
          // A fresh challenge requires a fresh assertion, not a replay. Delay
          // recovery to avoid a tight loop with a misconfigured server.
          this.retryTimer = setTimeout(() => this.startAutofill(), 1_000);
        }
      }
    }
  }

  private async fetch<T>(
    attempt: Attempt,
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown },
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const parent = attempt.controller.signal;
    parent.addEventListener('abort', abort, { once: true });
    if (parent.aborted) abort();
    // Better Fetch ignores `timeout` when a caller supplies `signal`.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      return await authClient.$fetch<T>(path, {
        ...options,
        signal: controller.signal,
        throw: false,
      });
    } catch (error) {
      // A timeout is a request failure, not a dismissed native prompt. Keep
      // superseded/disposed attempts quiet even if cancellation races expiry.
      if (timedOut && !parent.aborted) throw new PasskeyRequestTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    }
  }
}
