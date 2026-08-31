/**
 * Deno Connect backend for the app.
 *
 * The platform bundles this entry into a single JavaScript file, runs that
 * bundle with Deno, and injects:
 *   - HATCH_DATA_URL: managed Data Table API endpoint
 *   - HATCH_SIGNING_SECRET: backend authentication for that endpoint
 *   - HATCH_DEPLOYMENT_ID: active deployment identity for Data Table requests
 *   - PORT: the port to listen on
 *   - HATCH_ASSETS_DIR: absolute path to the read-only backend/assets directory
 *   - STORAGE_DIR: private persistent directory when storage is enabled
 *
 * Generated Connect stubs live in ../gen during the build and are included in
 * the bundle. Put runtime file resources in backend/assets and resolve them
 * from HATCH_ASSETS_DIR, not import.meta.url. Source, generated files, package
 * metadata, and lockfiles are not staged in the deployed artifact. Enable the
 * storage capability and use STORAGE_DIR when the backend needs mutable files.
 */
import http from 'node:http';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import type { ConnectRouter } from '@connectrpc/connect';
import { createDataClient, DataRequestError } from '@hatch/data';
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

const port = Number(Deno.env.get('PORT') ?? '8080');

http
  .createServer(connectNodeAdapter({ routes }))
  .listen(port, '127.0.0.1', () => {
    console.log(`app backend listening on 127.0.0.1:${port}`);
  });
