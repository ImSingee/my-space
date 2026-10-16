/** Domain-oriented fixture calls over real Connect JSON or binary transport. */
import { createConnectTransport } from '@connectrpc/connect-web';
import { cliClient, publicError } from '../../../packages/hatch-cli/src/client';

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
