/**
 * Deno Connect backend for the app.
 *
 * The platform bundles this entry into a single JavaScript file, runs that
 * bundle with Deno, and injects:
 *   - DATABASE_URL: connection string for this app's own Postgres database
 *   - PORT: the port to listen on
 *   - HATCH_ASSETS_DIR: absolute path to the read-only backend/assets directory
 *
 * Generated Connect stubs live in ../gen during the build and are included in
 * the bundle. Put runtime file resources in backend/assets and resolve them
 * from HATCH_ASSETS_DIR, not import.meta.url. Source, generated files, package
 * metadata, and lockfiles are not staged in the deployed artifact. Mutable
 * files belong in STORAGE_DIR when the storage capability is enabled.
 */
import http from 'node:http';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import type { ConnectRouter } from '@connectrpc/connect';
import postgres from 'postgres';
import { CounterService } from '../gen/service_pb.ts';

const sql = postgres(Deno.env.get('DATABASE_URL') ?? '', { max: 4 });

await sql`
  create table if not exists counter (
    id int primary key default 1,
    value int not null default 0
  )
`;
await sql`insert into counter (id, value) values (1, 0) on conflict (id) do nothing`;

function routes(router: ConnectRouter) {
  router.service(CounterService, {
    async getCount() {
      const [row] = await sql`select value from counter where id = 1`;
      return { count: row?.value ?? 0 };
    },
    async increment(req) {
      const amount = req.amount || 1;
      const [row] = await sql`
        update counter set value = value + ${amount} where id = 1 returning value
      `;
      return { count: row.value };
    },
  });
}

const port = Number(Deno.env.get('PORT') ?? '8080');

http.createServer(connectNodeAdapter({ routes })).listen(port, () => {
  console.log(`app backend listening on :${port}`);
});
