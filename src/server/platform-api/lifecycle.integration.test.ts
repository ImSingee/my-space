/** Durable public/security contract against the actual production build and DB. */
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  realpath,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { eq, sql } from 'drizzle-orm';
import { rpcCall } from './test-client';
import { cliClient } from '../../../packages/hatch-cli/src/client';
import { createConnectTransport } from '@connectrpc/connect-web';
import { Code, ConnectError } from '@connectrpc/connect';
import { create, toBinary } from '@bufbuild/protobuf';
import { errorFromJson } from '@connectrpc/connect/protocol-connect';
import { CreateAppRequestSchema } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/app_pb';
import { PublicErrorSchema } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/error_pb';
import { ViolationsSchema } from '@bufbuild/protovalidate/gen/buf/validate/validate_pb.js';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, RUNNER_WS_PATH } from '~agent/protocol';

const cliExecutable = fileURLToPath(
  new URL('../../../packages/hatch-cli/dist/main.mjs', import.meta.url),
);
const databaseUrl = process.env.HATCH_PLATFORM_TEST_DATABASE_URL;
const secret = 'disposable-platform-api-test-secret-32-characters';
const fleet = 'disposable-platform-api-fleet';
const runnerId = `public-test-${randomUUID()}`;
let root: string;
let origin: string;
let internal: string;
let runtime: ChildProcess;
let socket: WebSocket;
let database: typeof import('~/db');
let auth: typeof import('~auth/server').auth;
let cookie: string;
let credentials: Record<string, string>[];
let runId: string;
let sessionId: string;
let runToken: string;
let runtimeLog = '';
const resources: {
  collection: string;
  id: string;
  dir: string;
  generation: string;
}[] = [];

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function call(
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = response.headers
    .get('content-type')
    ?.includes('application/json')
    ? JSON.parse(text)
    : text;
  return { response, data };
}
const api = (
  endpoint: string,
  headers: Record<string, string>,
  body?: unknown,
) => rpcCall(origin, endpoint, headers, body);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
function git(dir: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
async function bundle(dir: string) {
  git(dir, 'add', '.');
  git(
    dir,
    '-c',
    'user.name=Public API Test',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    randomUUID(),
  );
  const file = path.join(root, `${randomUUID()}.bundle`);
  git(dir, 'bundle', 'create', file, 'HEAD');
  return (await readFile(file)).toString('base64');
}
async function mint(token = fleet, old = false) {
  return call(
    `${internal}/internal/api/${old ? 'cli/' : ''}runs/${runId}/token`,
    bearer(token),
    { runnerId },
  );
}

async function cliInvoke(
  args: string[],
  headers: Record<string, string>,
  extra: NodeJS.ProcessEnv = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HATCH_CLI_URL: origin,
    HATCH_CLI_TOKEN: headers.authorization?.slice(7),
    HATCH_CLI_API_KEY: headers['x-api-key'],
    FORCE_COLOR: undefined,
    ...extra,
  };
  const child = spawn(process.execPath, [cliExecutable, ...args, '--json'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, data: stdout ? JSON.parse(stdout) : null, stderr };
}

// Explicit opt-in; the caller must provision a disposable PostgreSQL server.
describe.runIf(Boolean(databaseUrl))(
  'Public API on the production build',
  () => {
    beforeAll(async () => {
      root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'hatch-public-api-')),
      );
      await mkdir(path.join(root, 'staging'));
      const port = await freePort();
      const internalPort = await freePort();
      origin = `http://127.0.0.1:${port}`;
      internal = `http://127.0.0.1:${internalPort}`;
      Object.assign(process.env, {
        DATABASE_URL: databaseUrl,
        APP_DATABASE_URL: databaseUrl,
        APP_URL: origin,
        SECRET: secret,
        BETTER_AUTH_SECRET: secret,
        HATCH_DATA_DIR: path.join(root, 'runtime'),
      });
      database = await import('~/db');
      const { migrate } = await import('drizzle-orm/postgres-js/migrator');
      await migrate(database.db, { migrationsFolder: 'migrations' });
      auth = (await import('~auth/server')).auth;
      runtime = spawn(process.execPath, ['dist/platform/server/index.mjs'], {
        env: {
          ...process.env,
          NODE_ENV: 'production',
          HOST: '127.0.0.1',
          PORT: String(port),
          AGENT_INTERNAL_PORT: String(internalPort),
          AGENT_INTERNAL_HOST: '127.0.0.1',
          AGENT_RUNNER_TOKEN: fleet,
          TMPDIR: path.join(root, 'staging'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      runtimeLog = '';
      runtime.stdout?.on('data', (value) => {
        log += value.toString();
        runtimeLog += value.toString();
      });
      runtime.stderr?.on('data', (value) => {
        log += value.toString();
        runtimeLog += value.toString();
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (runtime.exitCode !== null)
          throw new Error(`Production server exited: ${log}`);
        try {
          if ((await fetch(`${origin}/api/auth/ok`)).ok) break;
        } catch {
          /* wait for boot */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!(await fetch(`${origin}/api/auth/ok`)).ok)
        throw new Error('Production server failed to start.');
      const signup = await call(
        `${origin}/api/auth/sign-up/email`,
        { origin },
        {
          email: `${randomUUID()}@platform-api.test`,
          name: 'Disposable owner',
          password: 'disposable-platform-api-password',
        },
      );
      if (signup.response.status !== 200)
        throw new Error('Fixture signup failed.');
      cookie = signup.response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const key = await auth.api.createApiKey({
        body: {
          userId: signup.data.user.id,
          name: 'Public integration fixture',
        },
      });
      socket = new WebSocket(
        internal.replace('http:', 'ws:') + RUNNER_WS_PATH,
        { headers: bearer(fleet) },
      );
      await once(socket, 'open');
      const ready = new Promise<void>((resolve) =>
        socket.on('message', (raw) => {
          const message = JSON.parse(raw.toString());
          if (message.type === 'hub.hello_ack')
            socket.send(JSON.stringify({ type: 'runner.ready' }));
          if (message.type === 'hub.ready_ack') resolve();
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'runner.hello',
          runnerId,
          protocolVersion: PROTOCOL_VERSION,
          activeRunIds: [],
          workspaceSessionIds: [],
        }),
      );
      await ready;
      sessionId = randomUUID();
      runId = randomUUID();
      await database.db.insert(database.schema.agentSessions).values({
        id: sessionId,
        workspaceRunnerId: runnerId,
        workspaceAffinityState: 'claimed',
      });
      await database.db.insert(database.schema.agentRuns).values({
        id: runId,
        sessionId,
        providerId: 'fixture',
        modelId: 'fixture',
        input: { text: 'Public API integration' },
        runnerId,
        leaseExpiresAt: new Date(Date.now() + 600000),
      });
      const minted = await mint();
      if (!minted.response.ok)
        throw new Error(
          `Internal token issuance failed: ${JSON.stringify(minted.data)}`,
        );
      runToken = minted.data.token;
      credentials = [
        { cookie },
        { 'x-api-key': key.key },
        bearer(runToken),
        bearer(signup.data.token),
      ];
    }, 30000);
    beforeEach(async () => {
      // Every case starts with a live Run; long builds must not consume another
      // case's five-minute credential lifetime. Expiry cases still mint their
      // own deliberately expired JWTs.
      await database.db
        .update(database.schema.agentRuns)
        .set({ leaseExpiresAt: new Date(Date.now() + 600000) })
        .where(eq(database.schema.agentRuns.id, runId));
      const minted = await mint();
      assert.equal(
        minted.response.status,
        200,
        'Could not refresh the fixture Run token.',
      );
      runToken = minted.data.token;
      credentials[2] = bearer(runToken);
    });
    afterAll(async () => {
      socket?.terminate();
      if (runtime && runtime.exitCode === null) {
        const stopped = once(runtime, 'exit');
        runtime.kill('SIGTERM');
        const graceful = await Promise.race([
          stopped.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 5000),
          ),
        ]);
        if (!graceful && runtime.exitCode === null) {
          runtime.kill('SIGKILL');
          await stopped;
        }
      }
      if (process.env.HATCH_PLATFORM_TEST_EVIDENCE_DIR)
        await writeFile(
          path.join(
            process.env.HATCH_PLATFORM_TEST_EVIDENCE_DIR,
            'runtime.log',
          ),
          runtimeLog,
        );
      if (root) await rm(root, { recursive: true, force: true });
    }, 60000);

    it('executes all twelve operations with full authority for Cookie, Bearer session, API key and Run JWT', async () => {
      for (const [credentialIndex, headers] of credentials.entries()) {
        for (const collection of ['apps', 'workflows']) {
          const created = await api(collection, headers, {
            slug: `fixture-${randomUUID()}`,
            name: 'Public lifecycle',
            pin: false,
          });
          expect(created.response.status).toBe(200);
          const id = created.data.id as string;
          expect(Object.keys(created.data).sort()).toEqual([
            'files',
            'id',
            'name',
            'slug',
          ]);
          const detail = await api(`${collection}/${id}`, headers);
          expect(detail.response.status).toBe(200);
          expect(detail.data.id).toBe(id);
          expect(Object.keys(detail.data).sort()).toEqual([
            'createdAt',
            'description',
            'id',
            'name',
            'slug',
            'status',
            'updatedAt',
          ]);
          expect(
            (await api(collection, headers)).data.some(
              (row: { id: string }) => row.id === id,
            ),
          ).toBe(true);
          const emptySource = await api(`${collection}/${id}/source`, headers);
          expect(emptySource.data).toEqual({
            id,
            masterCommit: null,
            bundleBase64: null,
          });
          if (collection === 'apps' && credentialIndex === 2) {
            // oxlint-disable-next-line vitest/no-conditional-expect -- Run association is an App-only business contract.
            expect(
              await database.db.query.agentSessionApps.findFirst({
                where: { sessionId, appId: id },
              }),
            ).toBeDefined();
          }
          const dir = path.join(root, id);
          await mkdir(dir);
          git(dir, 'init', '-b', 'master');
          for (const file of created.data.files) {
            if (['package.json', 'deno.json', 'deno.lock'].includes(file.path))
              await writeFile(
                path.join(dir, file.path),
                Buffer.from(file.contentBase64, 'base64'),
              );
          }
          // Small real deploy artifacts avoid dependency on an unrelated app UI.
          await writeFile(
            path.join(dir, 'manifest.ts'),
            collection === 'apps'
              ? `export default { id: '${id}', name: 'API deploy', compatibilityVersion: 2, capabilities: { frontend: true }, app: { entry: 'main.ts', html: 'index.html', routes: [] } };`
              : `export default { id: '${id}', name: 'API deploy', compatibilityVersion: 1, entry: 'workflow.ts', network: [], triggers: { cron: [], webhook: false } };`,
          );
          if (collection === 'apps') {
            await writeFile(
              path.join(dir, 'main.ts'),
              "document.body.dataset.release = 'one';",
            );
            await writeFile(
              path.join(dir, 'index.html'),
              '<!doctype html><html><body>API release one</body></html>',
            );
          } else {
            await writeFile(
              path.join(dir, 'workflow.ts'),
              "import { defineWorkflow } from '@hatch/workflow'; import { z } from 'zod'; export default defineWorkflow({ input: z.object({}), async run() { return { release: 'one' }; } });",
            );
          }
          let upload = await bundle(dir);
          const deployBody = {
            message: 'First public release',
            generation: detail.data.createdAt,
            bundleBase64: upload,
          };
          const conflict = await api(`${collection}/${id}/deploy`, headers, {
            ...deployBody,
            generation: 'wrong-generation',
          });
          expect(conflict.response.status).toBe(409);
          expect(conflict.data.code).toBe('RESOURCE_GENERATION_CONFLICT');
          const first = await api(
            `${collection}/${id}/deploy`,
            headers,
            deployBody,
          );
          expect(first.response.status).toBe(200);
          expect(first.data.version).toBe(1);
          expect(Object.keys(first.data).sort()).toEqual([
            'compatibilityVersion',
            'deploymentId',
            'version',
          ]);
          const downloaded = await api(`${collection}/${id}/source`, headers);
          expect(downloaded.data.masterCommit).toBe(
            git(dir, 'rev-parse', 'HEAD'),
          );
          const sourceFile = path.join(root, `${id}.bundle`);
          await writeFile(
            sourceFile,
            Buffer.from(downloaded.data.bundleBase64, 'base64'),
          );
          const clone = path.join(root, `${id}-roundtrip`);
          execFileSync('git', ['clone', sourceFile, clone], { stdio: 'pipe' });
          expect(await readFile(path.join(clone, 'manifest.ts'), 'utf8')).toBe(
            await readFile(path.join(dir, 'manifest.ts'), 'utf8'),
          );
          if (collection === 'apps') {
            const served = await fetch(`${origin}/api/app/${id}/app/`, {
              headers: { cookie },
            });
            // oxlint-disable-next-line vitest/no-conditional-expect -- Only Apps have an HTTP frontend artifact.
            expect(served.status).toBe(200);
            // oxlint-disable-next-line vitest/no-conditional-expect -- Only Apps have an HTTP frontend artifact.
            expect(await served.text()).toContain('API release one');
          }
          await writeFile(path.join(dir, 'release.txt'), 'second release');
          upload = await bundle(dir);
          const second = await api(`${collection}/${id}/deploy`, headers, {
            ...deployBody,
            message: 'Second public release',
            bundleBase64: upload,
          });
          expect(second.response.status).toBe(200);
          expect(second.data.version).toBe(2);
          const rollback = await api(`${collection}/${id}/rollback`, headers, {
            version: 1,
          });
          expect(rollback.response.status).toBe(200);
          expect(rollback.data.version).toBe(1);
          expect(rollback.data.compatibility.isSupported).toBe(true);
          expect(
            (await api(`${collection}/${id}/source`, headers)).data
              .masterCommit,
          ).toBe(downloaded.data.masterCommit);
          const row =
            collection === 'apps'
              ? await database.db.query.apps.findFirst({ where: { id } })
              : await database.db.query.workflows.findFirst({ where: { id } });
          expect(row?.currentDeploymentId).toBe(first.data.deploymentId);
          resources.push({
            collection,
            id,
            dir,
            generation: detail.data.createdAt,
          });
          // A missing artifact must fail without changing the current release.
          const artifact = path.join(
            root,
            'runtime',
            collection === 'apps' ? 'artifacts' : 'workflow-artifacts',
            id,
            second.data.deploymentId,
          );
          await rm(artifact, { recursive: true, force: true });
          expect(
            (await api(`${collection}/${id}/rollback`, headers, { version: 2 }))
              .response.status,
          ).toBe(500);
          expect(
            (await api(`${collection}/${id}/source`, headers)).data
              .masterCommit,
          ).toBe(downloaded.data.masterCommit);
        }
      }
    }, 180000);

    it('preserves serialized versions, fast-forward denial and source recovery', async () => {
      for (const collection of ['apps', 'workflows']) {
        const resource = resources.find(
          (row) => row.collection === collection,
        )!;
        const { id, dir, generation } = resource;
        const bundleFile = path.join(root, `${randomUUID()}.bundle`);
        git(dir, 'bundle', 'create', bundleFile, 'HEAD');
        const body = {
          message: 'Concurrent release',
          generation,
          bundleBase64: (await readFile(bundleFile)).toString('base64'),
        };
        const releases = await Promise.all([
          api(`${collection}/${id}/deploy`, credentials[0], body),
          api(`${collection}/${id}/deploy`, credentials[1], body),
        ]);
        expect(releases.map((result) => result.response.status)).toEqual([
          200, 200,
        ]);
        expect(releases.map((result) => result.data.version).sort()).toEqual([
          3, 4,
        ]);
        const stable = await api(`${collection}/${id}/source`, credentials[2]);
        git(dir, 'checkout', '--orphan', 'divergent');
        await writeFile(path.join(dir, 'release.txt'), 'unrelated history');
        const divergent = await bundle(dir);
        const denied = await api(`${collection}/${id}/deploy`, credentials[2], {
          ...body,
          bundleBase64: divergent,
        });
        expect(denied.response.status).toBe(500);
        expect(denied.data.code).toBe('INTERNAL_SERVER_ERROR');
        expect(denied.data.message).not.toContain('git');
        expect(
          (await api(`${collection}/${id}/source`, credentials[0])).data
            .masterCommit,
        ).toBe(stable.data.masterCommit);
        const deployments =
          collection === 'apps'
            ? await database.db.query.deployments.findMany({
                where: { appId: id },
              })
            : await database.db.query.workflowDeployments.findMany({
                where: { workflowId: id },
              });
        expect(deployments).toHaveLength(4);
      }
    }, 180000);

    it('rechecks App generation after waiting for the live cutover lock', async () => {
      const { id, generation } = resources.find(
        (row) => row.collection === 'apps',
      )!;
      const source = await api(`apps/${id}/source`, credentials[0]);
      const { withAppDataCutoverLock } =
        await import('~server/apps/data-table/provision');
      let pending: ReturnType<typeof api> | undefined;
      let waiting = false;
      await withAppDataCutoverLock(id, async () => {
        pending = api(`apps/${id}/deploy`, credentials[0], {
          message: 'Queued generation fixture',
          generation,
          bundleBase64: source.data.bundleBase64,
        });
        for (let attempt = 0; attempt < 100; attempt++) {
          const rows = await database.db.execute(
            sql`select count(*)::integer as count from pg_locks where locktype = 'advisory' and classid = ${0x48445443}::oid and objid = hashtext(${id})::oid and not granted`,
          );
          if (Number(rows[0].count) > 0) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (!waiting)
          throw new Error(
            'The real HTTP deploy never waited on the held cutover lock.',
          );
        await database.db
          .update(database.schema.apps)
          .set({ createdAt: new Date(Date.parse(generation) + 1000) })
          .where(eq(database.schema.apps.id, id));
      });
      const denied = await pending!;
      expect(denied.response.status).toBe(409);
      expect(denied.data.code).toBe('CONFLICT');
      expect(
        (await api(`apps/${id}/source`, credentials[0])).data.masterCommit,
      ).toBe(source.data.masterCommit);
      expect(
        await database.db.query.deployments.findMany({ where: { appId: id } }),
      ).toHaveLength(4);
      await database.db
        .update(database.schema.apps)
        .set({ createdAt: new Date(generation) })
        .where(eq(database.schema.apps.id, id));
    });

    it('resolves exact IDs before colliding slugs and projects safe metadata on production', async () => {
      for (const collection of ['apps', 'workflows']) {
        const id = `legacy-${randomUUID()}`;
        const values = [
          {
            id: randomUUID(),
            slug: id,
            name: 'Slug holder',
            webhookSecret: 'fixture-webhook-secret',
          },
          {
            id,
            slug: `renamed-${randomUUID()}`,
            name: 'Exact ID owner',
            webhookSecret: 'fixture-webhook-secret',
          },
        ];
        if (collection === 'apps')
          await database.db.insert(database.schema.apps).values(values);
        else await database.db.insert(database.schema.workflows).values(values);
        const detail = await api(`${collection}/${id}`, credentials[1]);
        expect(detail.data.id).toBe(id);
        expect(detail.data.name).toBe('Exact ID owner');
        expect(detail.data.webhookSecret).toBeUndefined();
        expect(
          (await api(`${collection}/${id}/source`, credentials[2])).data.id,
        ).toBe(id);
        const list = await api(collection, credentials[0]);
        expect(JSON.stringify(list.data)).not.toContain(
          'fixture-webhook-secret',
        );
        expect(JSON.stringify(detail.data)).not.toContain(
          'fixture-webhook-secret',
        );
      }
    });

    it('requires exact destructive migration approval and retains newer data on rollback', async () => {
      const { id, generation } = resources.find(
        (row) => row.collection === 'apps',
      )!;
      const source = await api(`apps/${id}/source`, credentials[0]);
      const file = path.join(root, `${randomUUID()}.bundle`);
      await writeFile(file, Buffer.from(source.data.bundleBase64, 'base64'));
      const dir = path.join(root, `${id}-data`);
      execFileSync('git', ['clone', file, dir], { stdio: 'pipe' });
      const manifest = await readFile(path.join(dir, 'manifest.ts'), 'utf8');
      await writeFile(
        path.join(dir, 'manifest.ts'),
        manifest.replace('frontend: true', 'frontend: true, dataTable: true'),
      );
      await mkdir(path.join(dir, 'data'));
      await writeFile(
        path.join(dir, 'data/schema.ts'),
        "import { defineSchema, defineTable, t } from '@hatch/app/data'; export default defineSchema({ records: defineTable({ label: t.string(), value: t.integer().default(0) }) });",
      );
      const first = await api(`apps/${id}/deploy`, credentials[2], {
        generation,
        message: 'Enable managed data',
        bundleBase64: await bundle(dir),
      });
      expect(first.response.status).toBe(200);
      expect(first.data.version).toBe(5);
      const { resolveAppDataDatabaseUrl } =
        await import('~server/apps/data-table/provision');
      const dataDb = postgres(await resolveAppDataDatabaseUrl(id));
      await dataDb`insert into data.records (id, label, value) values ('durable-row', 'keep-until-approved', 41)`;

      await writeFile(
        path.join(dir, 'data/schema.ts'),
        "import { defineSchema, defineTable, t } from '@hatch/app/data'; export default defineSchema({ records: defineTable({ value: t.integer().default(0) }) });",
      );
      const body = {
        generation,
        message: 'Drop a managed field',
        bundleBase64: await bundle(dir),
      };
      await writeFile(
        path.join(dir, '.git', 'hatch-cli.json'),
        JSON.stringify({
          version: 1,
          kind: 'app',
          url: origin,
          id,
          generation,
          masterCommit: source.data.masterCommit,
        }),
      );
      const denied = await cliInvoke(
        ['app', 'deploy', '--directory', dir, '--message', body.message],
        credentials[1],
      );
      expect(denied.code).toBe(6);
      expect(denied.data.error.code).toBe('CONFLICT');
      const approval = /Approval token: ([a-f0-9]+)/.exec(
        denied.data.error.message,
      )?.[1];
      expect(approval).toBeDefined();
      expect(
        JSON.parse(
          await readFile(path.join(dir, '.git', 'hatch-cli.json'), 'utf8'),
        ).pending,
      ).toBeUndefined();
      const wrong = await cliInvoke(
        [
          'app',
          'deploy',
          '--directory',
          dir,
          '--allow-destructive-data-migration',
          '--data-migration-approval-token',
          'wrong-token',
        ],
        credentials[2],
      );
      expect(wrong.code).toBe(6);
      expect(
        (await api(`apps/${id}/source`, credentials[0])).data.masterCommit,
      ).not.toBe(git(dir, 'rev-parse', 'HEAD'));
      expect(
        await database.db.query.deployments.findMany({ where: { appId: id } }),
      ).toHaveLength(5);
      expect(
        (
          await dataDb`select label, value from data.records where id = 'durable-row'`
        )[0],
      ).toMatchObject({ label: 'keep-until-approved', value: 41 });
      const approved = await cliInvoke(
        [
          'app',
          'deploy',
          '--directory',
          dir,
          '--allow-destructive-data-migration',
          '--data-migration-approval-token',
          approval!,
        ],
        credentials[3],
      );
      assert.equal(approved.code, 0, JSON.stringify(approved));
      expect(approved.data.version).toBe(6);
      const deployment = await database.db.query.deployments.findFirst({
        where: { id: approved.data.deploymentId },
      });
      expect(deployment?.dataMigrationSummary).toMatchObject({
        destructive: true,
      });
      const before = await database.db.query.apps.findFirst({ where: { id } });
      const restored = await cliInvoke(
        ['app', 'rollback', id, '--version', '5'],
        credentials[2],
      );
      expect(restored.code).toBe(0);
      expect(restored.data.dataSchemaMismatch).toBe(true);
      const after = await database.db.query.apps.findFirst({ where: { id } });
      expect(after?.dataSchemaHash).toBe(before?.dataSchemaHash);
      expect(
        (
          await dataDb`select value from data.records where id = 'durable-row'`
        )[0].value,
      ).toBe(41);
      await dataDb.end();
    }, 180000);

    it('logs in with a real device session, stores/uses API keys and distinguishes logout from revocation', async () => {
      const config = path.join(root, 'device-config.json');
      const running = spawn(
        process.execPath,
        [
          cliExecutable,
          'auth',
          'login',
          '--url',
          origin,
          '--no-browser',
          '--config',
          config,
          '--json',
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            HATCH_CLI_URL: undefined,
            HATCH_CLI_TOKEN: undefined,
            HATCH_CLI_API_KEY: undefined,
            FORCE_COLOR: undefined,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      running.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      const finished = new Promise<number | null>((resolve, reject) => {
        running.once('error', reject);
        running.once('close', resolve);
      });
      const code = await new Promise<string>((resolve, reject) => {
        running.stderr.on('data', (chunk) => {
          stderr += chunk;
          const match = /Code: ([A-Za-z0-9-]+)/.exec(stderr);
          if (match) resolve(match[1]);
        });
        running.once('close', () =>
          reject(new Error('Device CLI stopped before printing its code.')),
        );
      });
      expect(
        (await call(`${origin}/api/auth/device?user_code=${code}`, { cookie }))
          .response.status,
      ).toBe(200);
      expect(
        (
          await call(
            `${origin}/api/auth/device/approve`,
            { cookie, origin },
            { userCode: code },
          )
        ).response.status,
      ).toBe(200);
      expect(await finished).toBe(0);
      const saved = JSON.parse(await readFile(config, 'utf8'));
      const token = saved.profiles.default.token;
      expect(stdout + stderr).not.toContain(token);
      const local = {
        HATCH_CLI_URL: undefined,
        HATCH_CLI_TOKEN: undefined,
        HATCH_CLI_API_KEY: undefined,
      };
      expect(
        (await cliInvoke(['auth', 'status', '--config', config], {}, local))
          .data.credentialType,
      ).toBe('session');
      const keyResult = await call(
        `${origin}/api/auth/api-key/create`,
        { ...bearer(token), origin },
        { name: 'CLI native lifecycle' },
      );
      expect(keyResult.response.status).toBe(200);
      const keyFile = path.join(root, 'private-api-key');
      await writeFile(keyFile, keyResult.data.key, { mode: 0o600 });
      const keyLogin = await cliInvoke(
        [
          'auth',
          'login',
          '--url',
          origin,
          '--api-key-file',
          keyFile,
          '--profile',
          'key',
          '--config',
          config,
        ],
        {},
        local,
      );
      expect(keyLogin.code).toBe(0);
      expect(keyLogin.data.credentialType).toBe('api-key');
      expect(
        (
          await cliInvoke(
            ['auth', 'logout', '--profile', 'key', '--config', config],
            {},
            local,
          )
        ).code,
      ).toBe(2);
      expect(
        (
          await cliInvoke(
            [
              'auth',
              'logout',
              '--local-only',
              '--profile',
              'key',
              '--config',
              config,
            ],
            {},
            local,
          )
        ).data.revoked,
      ).toBe(false);
      expect(
        (
          await cliInvoke(['auth', 'status'], {
            'x-api-key': keyResult.data.key,
          })
        ).code,
      ).toBe(0);
      expect(
        (
          await cliInvoke(
            ['auth', 'logout', '--profile', 'default', '--config', config],
            {},
            local,
          )
        ).data.revoked,
      ).toBe(true);
      expect((await cliInvoke(['auth', 'status'], bearer(token))).code).toBe(3);
      expect(
        (
          await cliInvoke(['auth', 'status'], {
            'x-api-key': keyResult.data.key,
          })
        ).code,
      ).toBe(0);
      await auth.api.deleteApiKey({
        headers: new Headers({ cookie }),
        body: { keyId: keyResult.data.id },
      });
      expect(
        (
          await cliInvoke(['auth', 'status'], {
            'x-api-key': keyResult.data.key,
          })
        ).code,
      ).toBe(3);
    }, 30000);

    it('runs installed-style CLI lifecycles and SDK preparation for session, API key and Run credentials', async () => {
      for (const headers of [credentials[3], credentials[1], credentials[2]]) {
        const verified = await cliInvoke(['auth', 'status'], headers, {
          HOME: path.join(root, 'no-cli-config'),
        });
        expect(verified.code).toBe(0);
        expect(verified.data.authority).toBe('platform');
        for (const kind of ['app', 'workflow']) {
          const directory = path.join(root, `cli-${randomUUID()}`);
          const clone = `${directory}-clone`;
          const file = `${directory}.json`;
          await writeFile(
            file,
            JSON.stringify({
              slug: `cli-${randomUUID()}`,
              name: 'Real CLI lifecycle',
              pin: false,
            }),
          );
          const created = await cliInvoke(
            [kind, 'create', '--file', file, '--directory', directory],
            headers,
          );
          assert.equal(created.code, 0, JSON.stringify(created));
          const id = created.data.id;
          expect((await cliInvoke([kind, 'get', id], headers)).code).toBe(0);
          expect(
            (await cliInvoke([kind, 'list'], headers)).data.some(
              (row: { id: string }) => row.id === id,
            ),
          ).toBe(true);
          const check = execFileSync(
            'deno',
            [
              'check',
              '--import-map',
              '.hatch/import-map.json',
              'manifest.ts',
              ...(kind === 'workflow'
                ? ['workflow.ts']
                : ['app/main.tsx', 'backend/main.ts']),
            ],
            {
              cwd: directory,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          expect(typeof check).toBe('string');
          const first = await cliInvoke(
            [
              kind,
              'deploy',
              '--directory',
              directory,
              '--message',
              'First CLI release',
            ],
            headers,
          );
          assert.equal(first.code, 0, JSON.stringify(first));
          expect(first.data.version).toBe(1);
          expect(
            (
              await cliInvoke(
                [kind, 'clone', id, '--directory', clone],
                headers,
              )
            ).code,
          ).toBe(0);
          await writeFile(path.join(clone, 'release.txt'), 'second');
          git(clone, 'add', '.');
          git(
            clone,
            '-c',
            'user.name=CLI integration',
            '-c',
            'user.email=fixture@example.test',
            'commit',
            '-m',
            'Second',
          );
          const second = await cliInvoke(
            [
              kind,
              'deploy',
              '--directory',
              clone,
              '--message',
              'Second CLI release',
            ],
            headers,
          );
          assert.equal(second.code, 0, JSON.stringify(second));
          expect(second.data.version).toBe(2);
          expect(
            (
              await cliInvoke(
                [kind, 'update', '--directory', directory],
                headers,
              )
            ).code,
          ).toBe(0);
          expect(git(directory, 'rev-parse', 'HEAD')).toBe(
            git(clone, 'rev-parse', 'HEAD'),
          );
          await writeFile(path.join(directory, 'release.txt'), 'third');
          git(directory, 'add', '.');
          git(
            directory,
            '-c',
            'user.name=CLI integration',
            '-c',
            'user.email=fixture@example.test',
            'commit',
            '-m',
            'Third',
          );
          const third = await cliInvoke(
            [kind, 'deploy', '--directory', directory],
            headers,
          );
          expect(third.code).toBe(0);
          expect(third.data.version).toBe(3);
          const restored = await cliInvoke(
            [kind, 'rollback', id, '--version', '2'],
            headers,
          );
          expect(restored.code).toBe(0);
          expect(restored.data.compatibility.isSupported).toBe(true);
          expect(
            (
              await api(
                `${kind === 'app' ? 'apps' : 'workflows'}/${id}/source`,
                headers,
              )
            ).data.masterCommit,
          ).toBe(git(clone, 'rev-parse', 'HEAD'));
          await writeFile(path.join(directory, 'local-only.txt'), 'keep');
          expect(
            (
              await cliInvoke(
                [kind, 'update', '--directory', directory],
                headers,
              )
            ).data.error.code,
          ).toBe('dirty_workspace');
          expect(
            await readFile(path.join(directory, 'local-only.txt'), 'utf8'),
          ).toBe('keep');
        }
      }
    }, 240000);

    it('uses Connect binary clients with the same domain behavior as JSON', async () => {
      const client = cliClient(
        createConnectTransport({
          baseUrl: `${origin}/api/rpc`,
          useBinaryFormat: true,
          interceptors: [
            (next) => (req) => {
              for (const [key, value] of Object.entries(credentials[1]))
                req.header.set(key, value);
              return next(req);
            },
          ],
        }),
      );
      const result = await client.workflows.create({
        slug: `typed-${randomUUID()}`,
        name: 'Typed client fixture',
        pin: false,
      });
      expect((await client.workflows.get({ id: result.id })).id).toBe(
        result.id,
      );
      expect(
        (await client.workflows.source({ id: result.id })).bundleBase64,
      ).toBeNull();
      await expect(client.apps.get({ id: 'missing' })).rejects.toMatchObject({
        code: Code.NotFound,
      });
    });

    it('validates the proto contract in JSON and binary and preserves optional false', async () => {
      const endpoint = `${origin}/api/rpc/hatch.platform.v1.AppService/CreateApp`;
      for (const binary of [false, true]) {
        const invalid = { slug: 'INVALID-SLUG', name: 'Private input value' };
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            cookie,
            'connect-protocol-version': '1',
            'content-type': binary ? 'application/proto' : 'application/json',
          },
          body: binary
            ? new Uint8Array(
                toBinary(
                  CreateAppRequestSchema,
                  create(CreateAppRequestSchema, invalid),
                ),
              )
            : JSON.stringify(invalid),
        });
        expect(response.status).toBe(400);
        const json = await response.json();
        expect(JSON.stringify(json)).not.toContain('Private input value');
        const error = errorFromJson(
          json,
          undefined,
          new ConnectError('Invalid Connect error'),
        );
        expect(error.code).toBe(Code.InvalidArgument);
        expect(error.findDetails(PublicErrorSchema)[0].code).toBe(
          'BAD_REQUEST',
        );
        expect(
          error.findDetails(ViolationsSchema)[0].violations[0].ruleId,
        ).toBe('string.pattern');
      }
      const invalidType = await fetch(endpoint, {
        method: 'POST',
        headers: {
          cookie,
          'connect-protocol-version': '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ slug: 'invalid-type', name: 123 }),
      });
      expect(invalidType.status).toBe(400);
      const workflow = await api(
        'workflows',
        { cookie },
        {
          slug: `presence-${randomUUID()}`,
          name: 'Optional false',
          pin: false,
        },
      );
      expect(workflow.response.status).toBe(200);
      expect(
        (
          await database.db.query.workflows.findFirst({
            where: { id: workflow.data.id },
          })
        )?.pinned,
      ).toBe(false);
      const sdk = await api('sdk/app', { cookie });
      expect(
        sdk.data.files.some(
          (file: { path: string }) => file.path === 'buf.gen.yaml',
        ),
      ).toBe(true);
      expect(sdk.data.tooling.bufVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('keeps deployed App Connect independent from Platform RPC', async () => {
      const directory = path.join(root, `app-connect-${randomUUID()}`);
      const input = `${directory}.json`;
      await writeFile(
        input,
        JSON.stringify({
          slug: `app-connect-${randomUUID()}`,
          name: 'Existing App Connect',
          pin: false,
        }),
      );
      const created = await cliInvoke(
        ['app', 'create', '--file', input, '--directory', directory],
        credentials[3],
      );
      assert.equal(created.code, 0, JSON.stringify(created));
      const release = await cliInvoke(
        ['app', 'deploy', '--directory', directory],
        credentials[3],
      );
      assert.equal(release.code, 0, JSON.stringify(release));
      const base = `${origin}/api/app/${created.data.id}/rpc/app.v1.CounterService`;
      const increment = await call(
        `${base}/Increment`,
        { cookie, 'connect-protocol-version': '1' },
        { amount: 2 },
      );
      assert.equal(
        increment.response.status,
        200,
        JSON.stringify(increment.data),
      );
      expect(increment.data.count).toBe(2);
      const count = await call(
        `${base}/GetCount`,
        { cookie, 'connect-protocol-version': '1' },
        {},
      );
      expect(count.response.status).toBe(200);
      expect(count.data.count).toBe(2);
    }, 120000);

    it('bounds actual streamed JSON bytes at 16 KiB and 256 MiB', async () => {
      async function streamed(endpoint: string, size: number, json = '{}') {
        const tail = Buffer.from(json);
        const padding = new Uint8Array(1024 * 1024).fill(32);
        let remaining = size - tail.length;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (remaining > 0) {
              const length = Math.min(remaining, padding.length);
              remaining -= length;
              controller.enqueue(padding.subarray(0, length));
            } else {
              controller.enqueue(tail);
              controller.close();
            }
          },
        });
        const response = await fetch(
          `${origin}/api/rpc/hatch.platform.v1.AppService/${endpoint.includes('/deploy') ? 'DeployApp' : 'CreateApp'}`,
          {
            method: 'POST',
            headers: {
              cookie,
              'content-type': 'application/json',
              'connect-protocol-version': '1',
            },
            body,
            duplex: 'half',
          } as RequestInit,
        );
        return { response, data: await response.json() };
      }
      const ordinary = await streamed(
        'apps',
        16 * 1024,
        JSON.stringify({
          slug: `limit-${randomUUID()}`,
          name: 'Boundary',
          pin: false,
        }),
      );
      expect(ordinary.response.status).toBe(200);
      expect((await streamed('apps', 16 * 1024 + 1)).response.status).toBe(429);
      const below = await streamed(
        'apps/absent/deploy',
        20 * 1024,
        JSON.stringify({
          message: 'Boundary',
          generation: 'absent',
          id: 'absent',
          bundle: 'YQ==',
        }),
      );
      expect(below.response.status).toBe(404);
      const exact = await streamed('apps/absent/deploy', 256 * 1024 * 1024);
      expect(exact.response.status).toBe(400); // Accepted size, invalid DTO.
      const excessive = await streamed(
        'apps/absent/deploy',
        256 * 1024 * 1024 + 1,
      );
      expect(excessive.response.status).toBe(429);
      expect(excessive.data.code).toBe('resource_exhausted');
    }, 60000);

    it('removes REST/OpenAPI and keeps public and internal credentials separate', async () => {
      for (const endpoint of [
        'openapi.json',
        'apps',
        'workflows',
        'auth/status',
        'sdk/app',
        'apps/absent/source',
        'workflows/absent/deploy',
      ]) {
        for (const prefix of ['/api/v1', '/api/cli/v1']) {
          const response = await fetch(`${origin}${prefix}/${endpoint}`);
          expect(response.status).toBe(404);
          expect(response.headers.get('content-type')).toContain(
            'application/json',
          );
          expect((await response.json()).code).toBe('NOT_FOUND');
        }
      }
      expect((await mint(fleet, true)).response.status).toBe(404);
      expect(
        (await api(`runs/${runId}/token`, credentials[0], { runnerId }))
          .response.status,
      ).toBe(404);
      for (const headers of credentials) {
        const token =
          headers['x-api-key'] ?? headers.authorization?.slice(7) ?? cookie;
        expect((await mint(token)).response.status).toBe(401);
      }
      expect((await api('apps', bearer(fleet))).response.status).toBe(401);
      expect(
        (await call(`${origin}/api/auth/get-session`, bearer(runToken))).data,
      ).toBeNull();
      expect(
        (await call(`${origin}/api/auth/api-key/list`, bearer(runToken)))
          .response.status,
      ).toBe(401);
    });

    it('rejects invalid explicit credentials even beside a valid Cookie and rechecks key lifecycle', async () => {
      for (const explicit of [
        { 'x-api-key': '' },
        { 'x-api-key': 'invalid' },
        { authorization: '' },
        { authorization: 'Basic invalid' },
        bearer('invalid-session'),
        bearer('a.b.c'),
      ]) {
        expect(
          (await api('apps', { cookie, ...explicit })).response.status,
        ).toBe(401);
      }
      const owner = await auth.api.getSession({
        headers: new Headers({ cookie }),
      });
      const key = await auth.api.createApiKey({
        body: { userId: owner!.user.id, name: 'Expiry fixture' },
      });
      expect(
        (await api('apps', { 'x-api-key': key.key })).response.status,
      ).toBe(200);
      await database.db
        .update(database.schema.apikey)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(database.schema.apikey.id, key.id));
      expect(
        (await api('apps', { cookie, 'x-api-key': key.key })).response.status,
      ).toBe(401);
      expect(
        (await cliInvoke(['auth', 'status'], { 'x-api-key': key.key })).code,
      ).toBe(3);
      const revoked = await auth.api.createApiKey({
        body: { userId: owner!.user.id, name: 'Revocation fixture' },
      });
      await auth.api.deleteApiKey({
        headers: new Headers({ cookie }),
        body: { keyId: revoked.id },
      });
      expect(
        (await api('workflows', { cookie, 'x-api-key': revoked.key })).response
          .status,
      ).toBe(401);
      const signup = await call(
        `${origin}/api/auth/sign-up/email`,
        { origin },
        {
          email: `${randomUUID()}@platform-api.test`,
          name: 'Deleted fixture',
          password: 'disposable-platform-api-password',
        },
      );
      const orphan = await auth.api.createApiKey({
        body: { userId: signup.data.user.id, name: 'Orphan fixture' },
      });
      await database.db
        .delete(database.schema.user)
        .where(eq(database.schema.user.id, signup.data.user.id));
      expect(
        (await api('apps', { cookie, 'x-api-key': orphan.key })).response
          .status,
      ).toBe(401);
    });

    it('rechecks Run status, exact bindings, lease and JWT expiry on production requests', async () => {
      const row = await database.db.query.agentRuns.findFirst({
        where: { id: runId },
      });
      for (const change of [
        { status: 'blocked' as const },
        { status: 'completed' as const },
        { runnerId: 'reassigned' },
        { leaseExpiresAt: new Date(Date.now() - 1000) },
      ]) {
        await database.db
          .update(database.schema.agentRuns)
          .set(change)
          .where(eq(database.schema.agentRuns.id, runId));
        expect(
          (await api('apps', { cookie, ...bearer(runToken) })).response.status,
        ).toBe('status' in change && change.status === 'blocked' ? 200 : 401);
        await database.db
          .update(database.schema.agentRuns)
          .set({
            status: row!.status,
            runnerId: row!.runnerId,
            leaseExpiresAt: new Date(Date.now() + 600000),
          })
          .where(eq(database.schema.agentRuns.id, runId));
      }
      const now = Math.floor(Date.now() / 1000);
      const expired = await auth.api.signJWT({
        body: {
          payload: {
            sub: runId,
            sid: sessionId,
            rnr: runnerId,
            iat: now - 600,
            exp: now - 300,
          },
        },
      });
      expect(
        (await api('apps', { cookie, ...bearer(expired.token) })).response
          .status,
      ).toBe(401);
      expect(
        (await cliInvoke(['auth', 'status'], bearer(expired.token))).code,
      ).toBe(3);
    });

    it('enforces Protovalidate, body caps, same-origin Cookie policy and safe errors', async () => {
      for (const contentType of [
        'text/plain',
        'application/x-www-form-urlencoded',
        'multipart/form-data',
      ]) {
        const response = await fetch(
          `${origin}/api/rpc/hatch.platform.v1.AppService/CreateApp`,
          {
            method: 'POST',
            headers: {
              cookie,
              'content-type': contentType,
              'connect-protocol-version': '1',
            },
            body: '{"slug":"unwanted","name":"unwanted"}',
          },
        );
        expect(response.status).toBe(415);
        expect(await response.text()).not.toContain('unwanted');
      }
      const compressed = await fetch(
        `${origin}/api/rpc/hatch.platform.v1.AppService/CreateApp`,
        {
          method: 'POST',
          headers: {
            cookie,
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'connect-protocol-version': '1',
          },
          body: new Uint8Array(
            gzipSync(
              JSON.stringify({
                slug: 'compressed',
                name: 'Compressed',
                description: 'a'.repeat(16384),
              }),
            ),
          ),
        },
      );
      expect(compressed.status).toBe(429);
      expect(JSON.stringify(await compressed.json())).not.toContain('aaaaaaa');
      const malformed = await fetch(
        `${origin}/api/rpc/hatch.platform.v1.AppService/CreateApp`,
        {
          method: 'POST',
          headers: {
            cookie,
            'content-type': 'application/json',
            'connect-protocol-version': '1',
          },
          body: '{"secret":"fixture-secret-value",',
        },
      );
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).not.toContain('fixture-secret-value');
      const invalid = await api(
        'apps',
        { cookie },
        {
          slug: 'INVALID-SLUG',
          name: 'Invalid',
          description: 'fixture-secret-value',
        },
      );
      expect(invalid.response.status).toBe(400);
      expect(invalid.data).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
      expect(invalid.data.data).toBeUndefined();
      expect(
        (
          await api(
            'apps',
            { cookie, origin: 'https://cross-origin.test' },
            { slug: 'unwanted', name: 'Unwanted' },
          )
        ).response.status,
      ).toBe(403);
      expect(
        (
          await api(
            'apps',
            { cookie, 'sec-fetch-site': 'cross-site' },
            { slug: 'unwanted', name: 'Unwanted' },
          )
        ).response.status,
      ).toBe(403);
      const preflight = await fetch(
        `${origin}/api/rpc/hatch.platform.v1.AppService/CreateApp`,
        {
          method: 'OPTIONS',
          headers: {
            origin: 'https://cross-origin.test',
            'access-control-request-method': 'POST',
          },
        },
      );
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
      const big = await api(
        'apps',
        { cookie },
        { slug: 'too-big', name: 'Too big', description: 'a'.repeat(16384) },
      );
      expect(big.response.status).toBe(429);
      expect(big.data.code).toBe('PAYLOAD_TOO_LARGE');
      const notFound = await api('apps/absent', { cookie });
      expect(notFound.response.status).toBe(404);
      for (const response of [
        big.response,
        invalid.response,
        notFound.response,
      ]) {
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      }
      // Non-JSON forms must never have produced rows.
      expect(
        await database.db.query.apps.findFirst({ where: { slug: 'unwanted' } }),
      ).toBeUndefined();
      // Successful and failed stages remove their private staging checkouts.
      expect(await readdir(path.join(root, 'staging'))).toEqual([]);
    });
  },
);
