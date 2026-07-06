/**
 * PlatformClient implementation: authenticated REST calls to the platform's
 * internal API (see src/server/agent-runner/internal-api.ts for the routes).
 */
import type {
  AppDeployResponse,
  CreateAppResult,
  CreateWorkflowResult,
  PlatformClient,
  QueryAppDbResponse,
  WorkflowDeployResponse,
} from '~agent/platform-client';
import type { SourceBundleResponse } from '~agent/protocol';

export function createPlatformRestClient(opts: {
  baseUrl: string;
  token: string;
}): PlatformClient {
  const call = async <T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    allow404 = false,
    signal?: AbortSignal,
  ): Promise<T> => {
    const res = await fetch(`${opts.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    if (allow404 && res.status === 404) {
      return null as T;
    }
    if (!res.ok) {
      let message = `Platform API ${method} ${path} failed (${res.status}).`;
      try {
        const payload = (await res.json()) as { error?: string };
        if (payload.error) message = payload.error;
      } catch {
        // Non-JSON error body; keep the generic message.
      }
      throw new Error(message);
    }
    return (await res.json()) as T;
  };

  const enc = encodeURIComponent;

  return {
    listApps: () => call('GET', '/internal/api/apps'),
    getApp: (handle) =>
      call('GET', `/internal/api/apps/${enc(handle)}`, undefined, true),
    createApp: (input) =>
      call<CreateAppResult>('POST', '/internal/api/apps', input),
    getAppSource: (handle) =>
      call<SourceBundleResponse>(
        'GET',
        `/internal/api/apps/${enc(handle)}/source`,
      ),
    deployApp: (id, body) =>
      call<AppDeployResponse>(
        'POST',
        `/internal/api/apps/${enc(id)}/deploy`,
        body,
      ),
    rollbackApp: (handle, version) =>
      call('POST', `/internal/api/apps/${enc(handle)}/rollback`, { version }),
    queryAppDb: (handle, sql, signal) =>
      call<QueryAppDbResponse>(
        'POST',
        `/internal/api/apps/${enc(handle)}/query-db`,
        { sql },
        false,
        signal,
      ),

    listWorkflows: () => call('GET', '/internal/api/workflows'),
    getWorkflow: (id) =>
      call('GET', `/internal/api/workflows/${enc(id)}`, undefined, true),
    createWorkflow: (input) =>
      call<CreateWorkflowResult>('POST', '/internal/api/workflows', input),
    getWorkflowSource: (id) =>
      call<SourceBundleResponse>(
        'GET',
        `/internal/api/workflows/${enc(id)}/source`,
      ),
    deployWorkflow: (id, body) =>
      call<WorkflowDeployResponse>(
        'POST',
        `/internal/api/workflows/${enc(id)}/deploy`,
        body,
      ),
    rollbackWorkflow: (id, version) =>
      call('POST', `/internal/api/workflows/${enc(id)}/rollback`, { version }),
  };
}
