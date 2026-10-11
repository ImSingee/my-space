/** Domain-oriented fixture calls over real Connect JSON or binary transport. */
import { createConnectTransport } from '@connectrpc/connect-web';
import { cliClient, publicError } from '../../../packages/hatch-cli/src/client';
import { errorFromJson } from '@connectrpc/connect/protocol-connect';
import { ConnectError } from '@connectrpc/connect';

export async function rpcCall<T = any>(
  origin: string,
  endpoint: string,
  headers: Record<string, string> = {},
  body?: any,
  fetcher: typeof fetch = fetch,
  useBinaryFormat = false,
): Promise<{ response: Response; data: T }> {
  let response: Response | undefined;
  const client = cliClient(
    createConnectTransport({
      baseUrl: `${origin}/api/rpc`,
      useBinaryFormat,
      interceptors: [
        (next) => (req) => {
          for (const [key, value] of Object.entries(headers))
            req.header.set(key, value);
          return next(req);
        },
      ],
      fetch: async (input, init) => {
        response = await fetcher(input, init);
        return response;
      },
    }),
  );
  const [collection, id, operation] = endpoint.split('/');
  if (
    collection === 'apps' &&
    ['kv', 'data-table', 'db', 'associate-session'].includes(operation)
  ) {
    const method = {
      kv: 'QueryAppKv',
      'data-table': 'QueryAppDataTable',
      db: 'QueryAppDb',
      'associate-session': 'AssociateAppSession',
    }[operation];
    const response = await fetcher(
      `${origin}/api/rpc/hatch.platform.v1.AppService/${method}`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'connect-protocol-version': '1',
        },
        body: JSON.stringify({
          id,
          ...(operation === 'db'
            ? body
            : operation === 'associate-session'
              ? body
              : { input: body }),
        }),
      },
    );
    const json = await response.json();
    if (!response.ok) {
      const error = publicError(
        errorFromJson(json, undefined, new ConnectError('RPC request failed.')),
      );
      return {
        response,
        data: {
          code: error.code,
          status: error.httpStatus,
          message: error.message,
        } as T,
      };
    }
    return {
      response,
      data: (operation === 'kv' || operation === 'data-table'
        ? json.result
        : json) as T,
    };
  }
  try {
    let data: unknown;
    if (collection === 'auth' && id === 'status')
      data = await client.auth.status({});
    else if (collection === 'sdk')
      data = await client.sdk.get({ kind: id as 'app' | 'workflow' });
    else if (collection === 'apps' || collection === 'workflows') {
      const api = client[collection];
      if (!id)
        data = body === undefined ? await api.list({}) : await api.create(body);
      else if (!operation) data = await api.get({ id });
      else if (operation === 'source') data = await api.source({ id });
      else if (operation === 'deploy')
        data = await api.deploy({ params: { id }, body });
      else if (operation === 'rollback')
        data = await api.rollback({ params: { id }, body });
      else return missing();
    } else return missing();
    return { response: response!, data: data as T };
  } catch (error) {
    if (!response) throw error;
    const safe = publicError(error);
    return {
      response,
      data: {
        code: safe.code,
        status: safe.httpStatus,
        message: safe.message,
      } as T,
    };
  }
  async function missing() {
    const value = await fetcher(
      `${origin}/api/rpc/hatch.platform.v1.UnknownService/Unknown`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'connect-protocol-version': '1',
        },
        body: '{}',
      },
    );
    return { response: value, data: (await value.json()) as T };
  }
}
