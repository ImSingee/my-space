import {
  apiPath,
  boundedSignal,
  canonicalizeInstanceUrl,
  MobileError,
  pathId,
  throwIfAborted,
  validateHandoff,
} from './security';
import type { InstanceUrlOptions } from './security';
import { streamRunEvents } from './stream';
import type { StreamOptions, StreamResult } from './stream';
import type { InstanceVault } from './vault';
import type {
  AppDetail,
  AppHandoff,
  AppSummary,
  AskAnswer,
  Attachment,
  CreateRunInput,
  MobileConfig,
  RunCreated,
  SessionDetail,
  SessionSummary,
} from './types';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type ClientOptions = InstanceUrlOptions & {
  origin: string;
  vault: InstanceVault;
  fetch: FetchLike;
  onUnauthorized?: (origin: string) => void;
};
type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT';
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  authenticate?: boolean;
  timeoutMs?: number;
};

function statusError(status: number): MobileError {
  const message =
    status === 401
      ? 'Your session expired. Sign in to this instance again.'
      : status === 403
        ? 'This account does not have access.'
        : status === 404
          ? 'This item is no longer available.'
          : status === 409
            ? 'This request conflicts with the current session. Refresh and try again.'
            : status === 413
              ? 'This attachment or message is too large.'
              : status === 429
                ? 'The instance is busy. Try again shortly.'
                : status >= 500
                  ? 'The instance could not complete this request.'
                  : 'The instance rejected this request.';
  return new MobileError(
    status === 401 ? 'unauthorized' : 'request_failed',
    message,
    status,
  );
}

/** One client is permanently bound to one canonical origin. */
export class HatchApiClient {
  readonly origin: string;
  readonly vault: InstanceVault;
  private readonly fetcher: FetchLike;
  private readonly onUnauthorized?: (origin: string) => void;
  constructor(options: ClientOptions) {
    this.origin = canonicalizeInstanceUrl(options.origin, options);
    this.vault = options.vault;
    this.fetcher = options.fetch;
    this.onUnauthorized = options.onUnauthorized;
  }

  private async fetchResponse(
    path: string,
    options: RequestOptions = {},
    credentialSnapshot?: string,
  ): Promise<Response> {
    const url = apiPath(this.origin, path);
    throwIfAborted(options.signal);
    const token =
      options.authenticate === false
        ? null
        : (credentialSnapshot ?? (await this.vault.get(this.origin)));
    throwIfAborted(options.signal);
    if (options.authenticate !== false && !token) throw statusError(401);
    const headers = new Headers(options.headers);
    headers.set('accept', headers.get('accept') ?? 'application/json');
    headers.set('cache-control', 'no-store');
    // Credentials never travel through URL query strings, cookies, or redirects.
    if (token) headers.set('authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        signal: options.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throwIfAborted(options.signal);
      throw new MobileError(
        'network_error',
        'Could not reach this instance. Check your connection and its HTTPS address.',
      );
    }
    if (options.signal?.aborted) {
      // A late response can arrive after an aborted header race has returned.
      void response.body?.cancel().catch(() => undefined);
      throwIfAborted(options.signal);
    }
    // Defense in depth for test/custom transports that ignore redirect:'error'.
    if (
      response.redirected ||
      (response.url && new URL(response.url).origin !== this.origin) ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new MobileError(
        'redirect_blocked',
        'The instance tried to redirect an API request.',
      );
    }
    if (
      response.status === 401 &&
      token &&
      (await this.vault.removeIfMatch(this.origin, token))
    ) {
      this.onUnauthorized?.(this.origin);
    }
    return response;
  }

  /** Includes an abortable timeout for the body, not just response headers. */
  request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestWithCredential(path, options);
  }

  private async requestWithCredential<T>(
    path: string,
    options: RequestOptions,
    credentialSnapshot?: string,
  ): Promise<T> {
    const bounded = boundedSignal(options.signal, options.timeoutMs ?? 30_000);
    try {
      const response = await this.fetchResponse(
        path,
        {
          ...options,
          signal: bounded.signal,
        },
        credentialSnapshot,
      );
      if (!response.ok) throw statusError(response.status);
      const value: unknown = await response.json();
      throwIfAborted(bounded.signal);
      if (typeof value !== 'object' || value === null) throw new Error();
      return value as T;
    } catch (error) {
      if (bounded.signal.aborted && !options.signal?.aborted) {
        throw new MobileError(
          'request_timeout',
          'The instance took too long to respond.',
        );
      }
      throwIfAborted(options.signal);
      if (error instanceof MobileError) throw error;
      throw new MobileError(
        'invalid_response',
        'The instance returned an invalid response.',
      );
    } finally {
      bounded.dispose();
    }
  }

  /** Login deliberately omits existing credentials and preserves OAuth errors. */
  async deviceRequest(
    path: '/api/auth/device/code' | '/api/auth/device/token',
    body: Record<string, string>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{ status: number; ok: boolean; data: Record<string, unknown> }> {
    const bounded = boundedSignal(signal, timeoutMs);
    try {
      const response = await this.fetchResponse(path, {
        authenticate: false,
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        signal: bounded.signal,
      });
      const data: unknown = await response.json();
      throwIfAborted(bounded.signal);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new MobileError(
          'invalid_response',
          'The instance returned an invalid login response.',
        );
      }
      return {
        status: response.status,
        ok: response.ok,
        data: data as Record<string, unknown>,
      };
    } finally {
      bounded.dispose();
    }
  }

  async apps(signal?: AbortSignal): Promise<AppSummary[]> {
    return (
      await this.request<{ apps: AppSummary[] }>('/api/mobile/v1/apps', {
        signal,
      })
    ).apps;
  }
  async app(id: string, signal?: AbortSignal): Promise<AppDetail> {
    return (
      await this.request<{ app: AppDetail }>(
        `/api/mobile/v1/apps/${pathId(id)}`,
        { signal },
      )
    ).app;
  }
  async sessions(
    appId?: string,
    signal?: AbortSignal,
  ): Promise<SessionSummary[]> {
    const query = appId ? `?appId=${pathId(appId)}` : '';
    return (
      await this.request<{ sessions: SessionSummary[] }>(
        `/api/mobile/v1/sessions${query}`,
        { signal },
      )
    ).sessions;
  }
  async session(id: string, signal?: AbortSignal): Promise<SessionDetail> {
    return (
      await this.request<{ session: SessionDetail }>(
        `/api/mobile/v1/sessions/${pathId(id)}`,
        { signal },
      )
    ).session;
  }
  async config(signal?: AbortSignal): Promise<MobileConfig> {
    const config = await this.request<MobileConfig>('/api/mobile/v1/config', {
      signal,
    });
    if (config.apiVersion !== 1) {
      throw new MobileError(
        'unsupported_api',
        'This instance uses an unsupported mobile API. Update Hatch and this app.',
      );
    }
    if (
      !Array.isArray(config.providers) ||
      !config.providers.every(
        (provider) =>
          provider &&
          typeof provider.id === 'string' &&
          typeof provider.name === 'string' &&
          Array.isArray(provider.models) &&
          provider.models.every(
            (model) =>
              model &&
              typeof model.id === 'string' &&
              typeof model.modelId === 'string' &&
              typeof model.name === 'string' &&
              typeof model.reasoning === 'boolean' &&
              Array.isArray(model.input) &&
              model.input.every((input) => typeof input === 'string') &&
              Number.isFinite(model.contextWindow) &&
              Number.isFinite(model.maxTokens),
          ),
      ) ||
      (config.defaultModel !== null &&
        (!config.defaultModel ||
          typeof config.defaultModel.providerId !== 'string' ||
          typeof config.defaultModel.modelId !== 'string'))
    ) {
      throw new MobileError(
        'invalid_response',
        'The instance returned an invalid mobile configuration.',
      );
    }
    return config;
  }
  createSession(
    input: { title?: string; providerId?: string; modelId?: string } = {},
    signal?: AbortSignal,
  ): Promise<{ id: string }> {
    return this.post('/api/mobile/v1/sessions', input, signal);
  }
  private post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      signal,
    });
  }
  async createRun(
    input: CreateRunInput,
    signal?: AbortSignal,
  ): Promise<RunCreated> {
    try {
      return await this.post('/api/agent/runs', input, signal);
    } catch (error) {
      if (
        error instanceof MobileError &&
        [
          'network_error',
          'request_timeout',
          'cancelled',
          'invalid_response',
        ].includes(error.code)
      ) {
        throw new MobileError(
          'ambiguous_run',
          'The run may have started. Refresh this session before sending again.',
        );
      }
      throw error;
    }
  }
  cancelRun(runId: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return this.post(`/api/agent/runs/${pathId(runId)}/cancel`, {}, signal);
  }
  answerRun(
    runId: string,
    askId: string,
    answers: AskAnswer[],
    signal?: AbortSignal,
  ): Promise<{ ok: boolean }> {
    return this.post(
      `/api/agent/runs/${pathId(runId)}/answer`,
      { askId, answers },
      signal,
    );
  }
  async uploadAttachment(
    sessionId: string,
    attachmentId: string,
    body: BodyInit,
    filename: string,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<Attachment> {
    // Retry an upload only with the SAME attachmentId; a new ID creates a new object.
    return (
      await this.request<{ attachment: Attachment }>(
        `/api/agent/sessions/${pathId(sessionId)}/attachments/${pathId(attachmentId)}`,
        {
          method: 'PUT',
          body,
          headers: {
            'content-type': contentType,
            'x-attachment-name': encodeURIComponent(filename),
          },
          signal,
          timeoutMs: 120_000,
        },
      )
    ).attachment;
  }
  async handoff(appId: string, signal?: AbortSignal): Promise<AppHandoff> {
    const handoff = await this.post<AppHandoff>(
      '/api/mobile/v1/handoffs',
      { appId },
      signal,
    );
    validateHandoff(this.origin, handoff);
    return handoff;
  }
  async streamRun(
    runId: string,
    options: StreamOptions,
  ): Promise<StreamResult> {
    const after = options.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0)
      throw new MobileError('invalid_cursor', 'Invalid stream cursor.');
    const headerTimeoutMs = options.headerTimeoutMs ?? 30_000;
    if (!Number.isFinite(headerTimeoutMs) || headerTimeoutMs <= 0) {
      throw new MobileError(
        'invalid_timeout',
        'Stream connection timeout must be positive.',
      );
    }
    const connection = boundedSignal(options.signal, headerTimeoutMs);
    let onAbort = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new MobileError('cancelled', 'Cancelled.'));
      connection.signal.addEventListener('abort', onAbort, { once: true });
      if (connection.signal.aborted) onAbort();
    });
    let response: Response;
    try {
      response = await Promise.race([
        this.fetchResponse(
          `/api/agent/runs/${pathId(runId)}/events?after=${after}`,
          {
            signal: connection.signal,
            headers: { accept: 'text/event-stream' },
          },
        ),
        interrupted,
      ]);
    } catch (error) {
      if (connection.signal.aborted) {
        throwIfAborted(options.signal);
        throw new MobileError(
          'stream_timeout',
          'The instance took too long to open the event stream. Reconnect to try again.',
        );
      }
      throw error;
    } finally {
      connection.signal.removeEventListener('abort', onAbort);
      connection.dispose();
    }
    if (!response.ok) throw statusError(response.status);
    return streamRunEvents(response, options);
  }
  async signOut(signal?: AbortSignal): Promise<void> {
    // A failed server revocation is surfaced; the UI may offer explicit local-only forget.
    const token = await this.vault.get(this.origin);
    if (!token) return;
    try {
      await this.requestWithCredential(
        '/api/auth/sign-out',
        {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
          signal,
        },
        token,
      );
    } catch (error) {
      if (!(error instanceof MobileError && error.status === 401)) throw error;
    }
    await this.vault.removeIfMatch(this.origin, token);
  }
}
