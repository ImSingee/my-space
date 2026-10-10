/**
 * Deno Connect backend for the app.
 *
 * The platform bundles this entry into a single JavaScript file, serves its
 * default Fetch handler with Deno, and injects:
 *   - HATCH_DATA_URL: managed Data Table API endpoint
 *   - HATCH_SIGNING_SECRET: backend authentication for that endpoint
 *   - HATCH_DEPLOYMENT_ID: active deployment identity for Data Table requests
 *   - HATCH_ASSETS_DIR: absolute path to the read-only backend/assets directory
 *   - STORAGE_DIR: private persistent directory when storage is enabled
 *
 * Generated Connect stubs live in ../gen during the build and are included in
 * the bundle. Put runtime file resources in backend/assets and resolve them
 * from HATCH_ASSETS_DIR, not import.meta.url. Source, generated files, package
 * metadata, and lockfiles are not staged in the deployed artifact. Enable the
 * storage capability and use STORAGE_DIR when the backend needs mutable files.
 */
import { createConnectRouter, type ConnectRouter } from '@connectrpc/connect';
import { compressionBrotli, compressionGzip } from '@connectrpc/connect-node';
import { createFetchHandler } from '@connectrpc/connect/protocol';
import { createDataClient, DataRequestError } from '@hatch/app/data';
import schema from '../data/schema.ts';
import { CounterService } from '../gen/service_pb.ts';
import { incrementCounter, readCounter, type CounterStore } from './counter.ts';

const data = createDataClient<typeof schema>({
  baseUrl: Deno.env.get('HATCH_DATA_URL') ?? '',
  signingSecret: Deno.env.get('HATCH_SIGNING_SECRET'),
});

const counter: CounterStore = {
  async find() {
    const result = await data.query({
      table: 'counters',
      where: [{ field: 'name', op: 'eq', value: 'default' }],
      limit: 1,
    });
    return result.items[0] ?? null;
  },
  insert(amount) {
    return data.insert('counters', { name: 'default', value: amount });
  },
  increment(id, amount) {
    return data.increment('counters', id, 'value', amount);
  },
};

function routes(router: ConnectRouter) {
  router.service(CounterService, {
    async getCount() {
      return { count: await readCounter(counter) };
    },
    async increment(req) {
      const amount = req.amount || 1;
      return {
        count: await incrementCounter(
          counter,
          amount,
          (error) => error instanceof DataRequestError && error.status === 409,
        ),
      };
    },
  });
}

const router = createConnectRouter({
  acceptCompression: [compressionGzip, compressionBrotli],
});
routes(router);
const handlers = new Map(
  router.handlers.map((handler) => [
    handler.requestPath,
    createFetchHandler(handler, { httpVersion: '1.1' }),
  ]),
);

async function handleRequest(request: Request): Promise<Response> {
  const handler = handlers.get(new URL(request.url).pathname);
  return handler?.(request) ?? new Response('Not found', { status: 404 });
}

export default {
  fetch: handleRequest,
} satisfies Deno.ServeDefaultExport;
