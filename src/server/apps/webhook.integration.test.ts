/* oxlint-disable vitest/no-standalone-expect -- Shared fixture assertions also validate setup/deploy contracts. */
/** Production HTTP + installed CLI + disposable PostgreSQL/Deno acceptance.
 * Opt in with HATCH_WEBHOOK_TEST_DATABASE_URL and HATCH_WEBHOOK_TEST_CLI.
 * The database must be disposable and dedicated to this test suite.
 */
import {
  spawn,
  execFile as execFileCallback,
  type ChildProcess,
} from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.HATCH_WEBHOOK_TEST_DATABASE_URL;
const cliEntry = process.env.HATCH_WEBHOOK_TEST_CLI;
const execFile = promisify(execFileCallback);
let origin: string;
let root: string;
let platform: ChildProcess;
let database: typeof import('~/db');
let auth: typeof import('~auth/server').auth;
let cookie: string;
let token: string;
let key: string;
let ownerId: string;
let appId: string;
let deploymentId: string;
let childEnv: NodeJS.ProcessEnv;
let platformLog = '';
const password = 'Webhook-fixture-password-long-enough-23';
const privateToken = 'fixture-app-private-token';
const providerKey = 'fixture-provider-signing-key';
const slug = `webhook-${randomUUID().slice(0, 8)}`;
const caps = {
  database: false,
  frontend: false,
  widgets: false,
  backend: true,
  cron: false,
  webhook: true,
  kv: false,
  storage: false,
  dataTable: false,
};

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function cli(
  args: string[],
  options: {
    stdin?: Buffer;
    credential?: { token?: string; apiKey?: string };
  } = {},
) {
  const env = {
    ...childEnv,
    HATCH_CLI_URL: origin,
    HATCH_CLI_TOKEN: options.credential?.apiKey
      ? undefined
      : (options.credential?.token ?? token),
    HATCH_CLI_API_KEY: options.credential?.apiKey,
  };
  return new Promise<{ code: number | null; stdout: Buffer; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cliEntry!, '--config', join(root, 'no-config.json'), ...args],
        { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', reject);
      child.once('exit', (code) =>
        resolve({
          code,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString(),
        }),
      );
      child.stdin.end(options.stdin);
    },
  );
}
const invoke = (args: string[] = [], options?: Parameters<typeof cli>[1]) =>
  cli(['app', 'invoke', 'webhook', slug, ...args], options);
const hook = (
  headers: Record<string, string | undefined> = {},
  options: { suffix?: string; body?: BodyInit; method?: string } = {},
) =>
  fetch(`${origin}/api/app/${appId}/hook${options.suffix ?? ''}`, {
    method: options.method ?? 'POST',
    headers: Object.fromEntries(
      Object.entries(headers).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    body: options.body,
    redirect: 'manual',
  });
async function appRow() {
  const app = await database.db.query.apps.findFirst({ where: { id: appId } });
  if (!app) throw new Error('Missing fixture App');
  return app;
}
async function signRun(overrides: Record<string, unknown> = {}) {
  const runId = randomUUID();
  const sessionId = randomUUID();
  await database.db
    .insert(database.schema.agentSessions)
    .values({ id: sessionId });
  await database.db.insert(database.schema.agentRuns).values({
    id: runId,
    sessionId,
    providerId: 'fixture',
    modelId: 'fixture',
    runnerId: 'fixture-runner',
    input: { text: 'fixture' },
    leaseExpiresAt: new Date(Date.now() + 300000),
  });
  const now = Math.floor(Date.now() / 1000);
  const result = await auth.api.signJWT({
    body: {
      payload: {
        sub: runId,
        sid: sessionId,
        rnr: 'fixture-runner',
        iat: now,
        exp: now + 300,
        ...overrides,
      },
    },
  });
  return { token: result.token, runId, sessionId };
}
function fixtureBackend(mode: 'platform' | 'none') {
  return `
const mode: string = ${JSON.stringify(mode)};
let count = 0;
async function hmac(secret: string, bytes: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array(bytes)))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export default { async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = new Uint8Array(await request.arrayBuffer());
  const timestamp = request.headers.get('x-hatch-timestamp');
  const signature = request.headers.get('x-hatch-signature');
  const secret = Deno.env.get('HATCH_SIGNING_SECRET');
  const prefix = new TextEncoder().encode(timestamp + '.');
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix); signed.set(body, prefix.length);
  const signedOK = !!(timestamp && secret && signature === 'sha256=' + await hmac(secret, signed));
  const privateOK = request.headers.get('x-app-token') === ${JSON.stringify(privateToken)} || request.headers.get('x-provider-signature') === await hmac(${JSON.stringify(providerKey)}, body);
  const diagnostics = { method: request.method, path: url.pathname, query: url.search, bytes: Array.from(body), signedOK, signaturePresent: !!signature, timestampPresent: !!timestamp, authorization: request.headers.get('authorization'), apiKey: request.headers.get('x-api-key'), cookie: request.headers.get('cookie'), secret: request.headers.get('x-hatch-secret'), hatchOther: request.headers.get('x-hatch-forged'), routing: request.headers.get('x-forwarded-host'), count: ++count };
  if (mode === 'platform' && !signedOK) return Response.json(diagnostics, { status: 401 });
  if (mode === 'none' && !privateOK) return Response.json(diagnostics, { status: 401 });
  if (url.pathname.endsWith('/binary')) return new Response(body, { status: 201, headers: { 'content-type': 'application/octet-stream' } });
  if (url.pathname.endsWith('/stream')) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0, 255])); setTimeout(() => { controller.enqueue(new Uint8Array([128, 10])); controller.close(); }, 500); } }), { headers: { 'content-type': 'application/octet-stream' } });
  if (url.pathname.endsWith('/text')) return new Response('plain webhook response', { status: 202, headers: { 'content-type': 'text/plain' } });
  if (url.pathname.endsWith('/failure')) return new Response(body, { status: 422, headers: { 'content-type': 'application/octet-stream' } });
  if (url.pathname.endsWith('/redirect')) return new Response(null, { status: 307, headers: { location: 'https://example.invalid/never' } });
  if (url.pathname.endsWith('/slow')) await new Promise((resolve) => setTimeout(resolve, 5000));
  return Response.json(diagnostics);
} } satisfies Deno.ServeDefaultExport;
`;
}
async function deploy(mode: 'platform' | 'none') {
  const directory = join(root, 'app');
  await rm(join(directory, 'manifest.ts'), { force: true });
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      id: appId,
      name: 'Webhook fixture',
      compatibilityVersion: 2,
      capabilities: caps,
      backend: { entry: 'backend/main.ts', runtime: 'deno-serve', network: [] },
      webhook: { auth: mode },
    }),
  );
  await writeFile(join(directory, 'backend/main.ts'), fixtureBackend(mode));
  await execFile('git', ['-C', directory, 'add', '-A']);
  await execFile('git', [
    '-C',
    directory,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@hatch.test',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-m',
    `Deploy ${mode} fixture`,
  ]);
  const result = await cli([
    'app',
    'deploy',
    '--directory',
    directory,
    '--message',
    `${mode} fixture`,
    '--timeout',
    '180',
    '--json',
  ]);
  expect(
    result.code,
    `Fixture deployment: ${result.stdout.toString()} ${result.stderr}`,
  ).toBe(0);
  const value = JSON.parse(result.stdout.toString()) as {
    deploymentId: string;
  };
  deploymentId = value.deploymentId;
}
function expectSanitized(value: Record<string, unknown>, signed: boolean) {
  expect(value).toMatchObject({
    authorization: null,
    apiKey: null,
    cookie: null,
    secret: null,
    hatchOther: null,
    routing: null,
    signaturePresent: signed,
    timestampPresent: signed,
    signedOK: signed,
  });
}

describe.runIf(Boolean(databaseUrl && cliEntry))(
  'App webhook production HTTP contract',
  () => {
    beforeAll(async () => {
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'hatch-webhook-http-')),
      );
      origin = `http://127.0.0.1:${await freePort()}`;
      const secret = 'isolated-webhook-platform-secret-longer-than-thirty-two';
      childEnv = {
        ...process.env,
        DATABASE_URL: databaseUrl,
        APP_DATABASE_URL: databaseUrl,
        APP_URL: origin,
        SECRET: secret,
        BETTER_AUTH_SECRET: secret,
        HATCH_DATA_DIR: join(root, 'runtime'),
        AGENT_INTERNAL_HOST: '127.0.0.1',
        AGENT_INTERNAL_PORT: String(await freePort()),
        AGENT_RUNNER_TOKEN: 'isolated-webhook-fleet-token',
        HOST: '127.0.0.1',
        PORT: new URL(origin).port,
        NODE_ENV: 'production',
        HATCH_CLI_URL: undefined,
        HATCH_CLI_TOKEN: undefined,
        HATCH_CLI_API_KEY: undefined,
      };
      Object.assign(process.env, {
        DATABASE_URL: databaseUrl,
        APP_URL: origin,
        SECRET: secret,
        BETTER_AUTH_SECRET: secret,
        HATCH_DATA_DIR: childEnv.HATCH_DATA_DIR,
      });
      database = await import('~/db');
      const { migrate } = await import('drizzle-orm/postgres-js/migrator');
      await migrate(database.db, { migrationsFolder: 'migrations' });
      platform = spawn(
        process.execPath,
        [resolve('dist/platform/server/index.mjs')],
        { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      for (const stream of [platform.stdout, platform.stderr])
        stream?.on('data', (chunk: Buffer) => {
          platformLog += chunk.toString();
        });
      for (let i = 0; i < 300; i++) {
        if (platform.exitCode !== null)
          throw new Error('Fixture platform exited during startup.');
        if (
          await fetch(`${origin}/api/auth/get-session`).then(
            (r) => r.status === 200,
            () => false,
          )
        )
          break;
        if (i === 299) throw new Error('Fixture platform startup timed out.');
        await delay(100);
      }
      const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          email: `${randomUUID()}@webhook.test`,
          password,
          name: 'Webhook owner',
        }),
      });
      expect(signup.status).toBe(200);
      cookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const created = (await signup.json()) as {
        token: string;
        user: { id: string };
      };
      token = created.token;
      ownerId = created.user.id;
      auth = (await import('~auth/server')).auth;
      key = (
        await auth.api.createApiKey({
          body: { userId: ownerId, name: 'Webhook fixture' },
        })
      ).key;
      await writeFile(
        join(root, 'create.json'),
        JSON.stringify({ slug, name: 'Webhook fixture' }),
      );
      const result = await cli([
        'app',
        'create',
        '--file',
        join(root, 'create.json'),
        '--directory',
        join(root, 'app'),
        '--json',
      ]);
      expect(
        result.code,
        `Fixture creation: ${result.stdout.toString()} ${result.stderr}`,
      ).toBe(0);
      appId = (JSON.parse(result.stdout.toString()) as { id: string }).id;
      await deploy('platform');
    }, 240000);
    afterAll(async () => {
      if (platform && platform.exitCode === null) {
        platform.kill('SIGTERM');
        await Promise.race([once(platform, 'exit'), delay(2000)]);
        if (platform.exitCode === null) platform.kill('SIGKILL');
      }
      // Logs are inspected locally and retained only after redacting fixture
      // credentials; no report upload or external services are used.
      if (root) {
        let safe = platformLog;
        for (const value of [
          token,
          key,
          cookie,
          database && appId ? (await appRow()).webhookSecret : null,
        ])
          if (value) safe = safe.replaceAll(value, '[redacted]');
        if (process.env.HATCH_WEBHOOK_TEST_LOG)
          await writeFile(process.env.HATCH_WEBHOOK_TEST_LOG, safe);
        await rm(root, { recursive: true, force: true });
      }
    }, 30000);

    it('authenticates legacy secret, Cookie, Bearer, API key and live native Run credentials, stripping all reserved headers', async () => {
      const app = await appRow();
      const run = await signRun();
      for (const [index, credential] of [
        { 'x-hatch-secret': app.webhookSecret! },
        { cookie, origin },
        { cookie, 'sec-fetch-site': 'same-origin' },
        { authorization: `Bearer ${token}` },
        { 'x-api-key': key },
        { authorization: `Bearer ${run.token}` },
        // API key wins over invalid Bearer, Cookie and secret.
        {
          'X-API-Key': key,
          AUTHORIZATION: 'invalid',
          cookie: 'invalid',
          'x-hatch-secret': 'invalid',
        },
      ].entries()) {
        const response = await hook(
          {
            ...credential,
            'x-hatch-signature': 'forged',
            'x-hatch-timestamp': '0',
            'x-hatch-forged': 'private',
            ...('sec-fetch-site' in credential
              ? {}
              : { 'x-forwarded-host': 'evil.test' }),
          },
          { body: '中文 raw\n', suffix: '/provider/events?delivery=one' },
        );
        expect(response.status, `credential case ${index}`).toBe(200);
        const value = (await response.json()) as Record<string, unknown>;
        expectSanitized(value, true);
        expect(value.path).toBe('/__webhook/provider/events');
        expect(value.query).toBe('?delivery=one');
        expect(value.bytes).toEqual([...Buffer.from('中文 raw\n')]);
      }
    });

    it('rejects invalid/empty/expired/revoked credentials with no secret/Cookie fallback and native Run binding failures', async () => {
      const app = await appRow();
      const revoked = await auth.api.createApiKey({
        body: { userId: ownerId, name: 'Revoked fixture' },
      });
      await auth.api.deleteApiKey({
        body: { keyId: revoked.id },
        headers: new Headers({ cookie }),
      });
      const expired = await auth.api.createApiKey({
        body: { userId: ownerId, name: 'Expired fixture' },
      });
      await database.db
        .update(database.schema.apikey)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(database.schema.apikey.id, expired.id));
      const owner = await database.db.query.user.findFirst({
        where: { id: ownerId },
      });
      const expiredSession = await auth.api.signInEmail({
        body: { email: owner!.email, password },
      });
      await database.db
        .update(database.schema.session)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(database.schema.session.token, expiredSession.token));
      const revokedSession = await auth.api.signInEmail({
        body: { email: owner!.email, password },
      });
      await database.db
        .delete(database.schema.session)
        .where(eq(database.schema.session.token, revokedSession.token));
      const orphan = await auth.api.createApiKey({
        body: { userId: ownerId, name: 'Missing owner fixture' },
      });
      await database.db
        .update(database.schema.apikey)
        .set({ referenceId: 'missing-fixture-owner' })
        .where(eq(database.schema.apikey.id, orphan.id));
      const expiredRun = await signRun({
        exp: Math.floor(Date.now() / 1000) - 60,
      });
      const badSessionRun = await signRun({ sid: 'another-session' });
      const badRunnerRun = await signRun({ rnr: 'another-runner' });
      const ended = await signRun();
      await database.db
        .update(database.schema.agentRuns)
        .set({ status: 'completed' })
        .where(eq(database.schema.agentRuns.id, ended.runId));
      const expiredLease = await signRun();
      await database.db
        .update(database.schema.agentRuns)
        .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(database.schema.agentRuns.id, expiredLease.runId));
      for (const headers of [
        { 'x-api-key': '', authorization: `Bearer ${token}` },
        { 'x-api-key': 'invalid', authorization: `Bearer ${token}` },
        { 'x-api-key': expired.key },
        { 'x-api-key': revoked.key },
        { 'x-api-key': orphan.key },
        { authorization: `Bearer ${expiredSession.token}` },
        { authorization: `Bearer ${revokedSession.token}` },
        { authorization: '' },
        { authorization: 'Basic invalid' },
        { authorization: 'Bearer invalid' },
        { authorization: 'Bearer a.b.c' },
        ...[expiredRun, badSessionRun, badRunnerRun, ended, expiredLease].map(
          (run) => ({ authorization: `Bearer ${run.token}` }),
        ),
      ]) {
        const response = await hook(
          { cookie, origin, 'x-hatch-secret': app.webhookSecret!, ...headers },
          { suffix: `?secret=${app.webhookSecret}` },
        );
        expect(response.status).toBe(401);
        expect(await response.text()).toBe('Unauthorized');
      }
    });

    it('enforces Cookie CSRF and explicit secret/query precedence without broadening CORS', async () => {
      const app = await appRow();
      for (const headers of [
        { cookie },
        { cookie, origin: 'https://evil.test' },
        { cookie, origin, 'sec-fetch-site': 'cross-site' },
      ]) {
        const response = await hook(headers, { method: 'GET' });
        expect(response.status).toBe(403);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      }
      expect((await hook({})).status).toBe(403);
      expect(
        (
          await hook(
            { cookie, origin, 'x-hatch-secret': '' },
            { suffix: `?secret=${app.webhookSecret}` },
          )
        ).status,
      ).toBe(403);
      const query = await hook(
        {},
        { suffix: `?secret=${app.webhookSecret}&delivery=x` },
      );
      expect(query.status).toBe(200);
      expect(((await query.json()) as { query: string }).query).toBe(
        '?delivery=x',
      );
      for (const headers of [
        { 'x-hatch-secret': app.webhookSecret! },
        { authorization: `Bearer ${token}` },
      ]) {
        const response = await hook(headers, {
          suffix: '?secret=app-owned&delivery=x',
        });
        expect(response.status).toBe(200);
        expect(((await response.json()) as { query: string }).query).toBe(
          '?secret=app-owned&delivery=x',
        );
      }
    });

    it('keeps raw HMAC binary/empty bodies, all methods, size bounds and response status/bytes', async () => {
      const headers = { authorization: `Bearer ${token}` };
      for (const method of [
        'GET',
        'HEAD',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
        'OPTIONS',
      ]) {
        const response = await hook(headers, {
          method,
          body: ['GET', 'HEAD'].includes(method)
            ? undefined
            : new Uint8Array([0, 255, 128, 10]),
          suffix: '/verbs',
        });
        expect(response.status).toBe(200);
        if (method !== 'HEAD')
          expectSanitized(
            (await response.json()) as Record<string, unknown>,
            true,
          );
        else {
          const body = await response.text();
          if (body !== '') throw new Error('HEAD must have no response body.');
        }
      }
      const empty = await hook(headers);
      expectSanitized((await empty.json()) as Record<string, unknown>, true);
      const oversize = await hook(headers, {
        body: Buffer.alloc(1024 * 1024 + 1),
      });
      expect(oversize.status).toBe(413);
      const chunkedInit: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        headers,
        duplex: 'half',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
      };
      expect(
        (await fetch(`${origin}/api/app/${appId}/hook`, chunkedInit)).status,
      ).toBe(413);
      const streaming = await hook(headers, { suffix: '/stream' });
      const reader = streaming.body!.getReader();
      const first = await reader.read();
      expect(first.value).toEqual(new Uint8Array([0, 255]));
      const second = await reader.read();
      expect(second.value).toEqual(new Uint8Array([128, 10]));
      expect((await reader.read()).done).toBe(true);
      const binary = new Uint8Array([0, 255, 128, 10]);
      const echoed = await hook(headers, { body: binary, suffix: '/binary' });
      expect(echoed.status).toBe(201);
      expect(new Uint8Array(await echoed.arrayBuffer())).toEqual(binary);
      const failure = await hook(headers, { body: binary, suffix: '/failure' });
      expect(failure.status).toBe(422);
      expect(new Uint8Array(await failure.arrayBuffer())).toEqual(binary);
    });

    it('uses installed CLI from outside the repo for file/stdin/empty, text/binary/JSON, App headers and actual HTTP exits', async () => {
      const bytes = Buffer.from([0, 255, 128, 10]);
      await writeFile(join(root, 'payload.bin'), bytes);
      const file = await invoke([
        '--file',
        'payload.bin',
        '--path',
        'binary',
        '--workdir',
        root,
      ]);
      expect(file.code).toBe(0);
      expect(file.stdout).toEqual(bytes);
      const stdin = await invoke(
        ['--file', '-', '--path', 'binary', '--json'],
        { stdin: bytes, credential: { apiKey: key } },
      );
      expect(stdin.code).toBe(0);
      expect(JSON.parse(stdin.stdout.toString())).toMatchObject({
        status: 201,
        bodyEncoding: 'base64',
        body: bytes.toString('base64'),
      });
      const text = await invoke(['--path', 'text']);
      expect(text.code).toBe(0);
      expect(text.stdout.toString()).toBe('plain webhook response');
      const empty = await invoke([
        '--json',
        '--query',
        'delivery=a&b?#%',
        '--header',
        'X-App-Token: app-value',
      ]);
      expect(empty.code).toBe(0);
      const json = JSON.parse(empty.stdout.toString()) as { body: string };
      const value = JSON.parse(
        Buffer.from(json.body, 'base64').toString(),
      ) as Record<string, unknown>;
      expectSanitized(value, true);
      expect(value.bytes).toEqual([]);
      expect(value.query).toBe('?delivery=a%26b%3F%23%25');
      const failed = await invoke(
        ['--file', '-', '--path', 'failure', '--json'],
        { stdin: bytes },
      );
      expect(failed.code).toBe(7);
      expect(JSON.parse(failed.stdout.toString())).toMatchObject({
        ok: false,
        status: 422,
        body: bytes.toString('base64'),
      });
      const help = await cli(['help', 'app', 'invoke', 'webhook', '--json']);
      expect(help.code).toBe(0);
      expect(JSON.parse(help.stdout.toString()).commands[0].supported).toBe(
        true,
      );
      await expect(access(join(root, 'no-config.json'))).rejects.toThrow(
        /ENOENT/,
      );
    });

    it.runIf(Boolean(process.env.HATCH_WEBHOOK_TEST_CONTAINER_IMAGE))(
      'invokes through the installed bundle in a nonroot read-only container',
      async () => {
        const script = `
const http = require('node:http');
const { spawn } = require('node:child_process');
(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const relay = http.createServer((request, response) => {
    const upstream = http.request({ hostname: 'host.docker.internal', port: input.port, path: request.url, method: request.method, headers: request.headers }, (result) => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, HATCH_CLI_URL: 'http://127.0.0.1:' + relay.address().port, HATCH_CLI_API_KEY: input.key };
  const child = spawn(process.execPath, ['/cli/dist/main.mjs', 'app', 'invoke', 'webhook', input.id, '--json'], { env, cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.resume();
  const code = await new Promise((resolve) => child.once('exit', resolve));
  relay.closeAllConnections(); relay.close();
  if (code !== 0) throw new Error('Container invocation failed with exit ' + code);
  const result = JSON.parse(Buffer.concat(out).toString());
  const body = JSON.parse(Buffer.from(result.body, 'base64').toString());
  if (result.status !== 200 || body.apiKey !== null || body.authorization !== null || !body.signedOK) throw new Error('Container boundary failed');
  console.log(JSON.stringify({ uid: process.getuid(), status: result.status, signed: body.signedOK, credentialsAbsent: true }));
})().catch(() => { console.error('Container webhook verification failed'); process.exitCode = 1; });
`;
        const child = spawn(
          'docker',
          [
            'run',
            '--rm',
            '-i',
            '--user',
            '10001:10001',
            '--read-only',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--tmpfs',
            '/tmp:rw,noexec,nosuid,size=16m',
            ...(process.platform === 'linux'
              ? ['--add-host=host.docker.internal:host-gateway']
              : []),
            '--mount',
            `type=bind,src=${resolve(cliEntry!, '../..')},dst=/cli,readonly`,
            process.env.HATCH_WEBHOOK_TEST_CONTAINER_IMAGE!,
            'node',
            '-e',
            script,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        const out: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.stderr.resume();
        child.stdin.end(
          JSON.stringify({ port: new URL(origin).port, key, id: appId }),
        );
        expect((await once(child, 'exit'))[0]).toBe(0);
        expect(JSON.parse(Buffer.concat(out).toString())).toEqual({
          uid: 10001,
          status: 200,
          signed: true,
          credentialsAbsent: true,
        });
      },
      60000,
    );

    it('refuses CLI URL/header/body overrides, redirects and cancels once without a retry', async () => {
      for (const args of [
        ['--path', '../rpc'],
        ['--path', 'https://evil.test'],
        ['--path', '%2e%2e/rpc'],
        ['--path', 'ok?bad=x'],
        ['--header', 'Authorization: app-private'],
        ['--header', 'X-API-KEY: app-private'],
        ['--header', 'Cookie: app-private'],
        ['--header', 'X-Hatch-Signature: forged'],
        ['--method', 'HEAD', '--file', '-'],
        ['--method', 'TRACE'],
      ]) {
        const result = await invoke([...args, '--json']);
        expect(result.code).toBe(2);
      }
      const redirect = await invoke(['--path', 'redirect', '--json']);
      expect(redirect.code).toBe(7);
      const timeout = await invoke([
        '--path',
        'slow',
        '--timeout',
        '0.3',
        '--json',
      ]);
      expect(timeout.code).toBe(7);
      const env = {
        ...childEnv,
        HATCH_CLI_URL: origin,
        HATCH_CLI_TOKEN: token,
      };
      const child = spawn(
        process.execPath,
        [
          cliEntry!,
          'app',
          'invoke',
          'webhook',
          slug,
          '--path',
          'slow',
          '--json',
        ],
        { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      await delay(500);
      child.kill('SIGINT');
      expect((await once(child, 'exit'))[0]).toBe(130);
    });

    it('blocks retained URLs after archive, disabled/missing/unsupported deployment and capability changes', async () => {
      const app = await appRow();
      for (const patch of [
        { status: 'archived' as const },
        { status: 'failed' as const, currentDeploymentId: null },
        { capabilities: { ...caps, webhook: false } },
        { capabilities: { ...caps, backend: false } },
      ]) {
        await database.db
          .update(database.schema.apps)
          .set(patch)
          .where(eq(database.schema.apps.id, appId));
        expect((await hook({ authorization: `Bearer ${token}` })).status).toBe(
          404,
        );
        await database.db
          .update(database.schema.apps)
          .set({
            status: 'deployed',
            currentDeploymentId: deploymentId,
            capabilities: caps,
          })
          .where(eq(database.schema.apps.id, appId));
      }
      expect(
        (await fetch(`${origin}/api/app/missing-fixture/hook`)).status,
      ).toBe(404);
      await database.db
        .update(database.schema.deployments)
        .set({ compatibilityVersion: 0 })
        .where(eq(database.schema.deployments.id, app.currentDeploymentId!));
      expect((await hook({ authorization: `Bearer ${token}` })).status).toBe(
        503,
      );
      await database.db
        .update(database.schema.deployments)
        .set({ compatibilityVersion: 2 })
        .where(eq(database.schema.deployments.id, app.currentDeploymentId!));
      await database.db
        .update(database.schema.deployments)
        .set({ status: 'failed' })
        .where(eq(database.schema.deployments.id, deploymentId));
      expect((await hook({ authorization: `Bearer ${token}` })).status).toBe(
        503,
      );
      await database.db
        .update(database.schema.deployments)
        .set({ status: 'deployed' })
        .where(eq(database.schema.deployments.id, deploymentId));
      // A failed redeploy must leave the previous live webhook callable.
      await database.db
        .update(database.schema.apps)
        .set({ status: 'building' })
        .where(eq(database.schema.apps.id, appId));
      expect((await hook({ authorization: `Bearer ${token}` })).status).toBe(
        200,
      );
      await database.db
        .update(database.schema.apps)
        .set({ status: 'deployed' })
        .where(eq(database.schema.apps.id, appId));
    });

    it('keeps none mode public/unsigned, strips mixed-case credentials, and enforces App-owned authentication even for platform callers', async () => {
      await deploy('none');
      for (const credentials of [
        {},
        {
          AuThOrIzAtIoN: 'invalid',
          'X-aPi-KeY': 'invalid',
          Cookie: 'invalid',
          'X-Hatch-Secret': 'invalid',
          'x-hatch-signature': 'forged',
          'x-hatch-forged': 'forged',
          'x-forwarded-host': 'evil.test',
        },
        { authorization: `Bearer ${token}` },
        { 'x-api-key': key },
      ]) {
        const denied = await hook(credentials);
        expect(denied.status).toBe(401);
        expectSanitized(
          (await denied.json()) as Record<string, unknown>,
          false,
        );
        const response = await hook(
          { ...credentials, 'X-App-Token': privateToken },
          { suffix: '/private?secret=app-owned', body: 'provider raw bytes' },
        );
        expect(response.status).toBe(200);
        const value = (await response.json()) as Record<string, unknown>;
        expectSanitized(value, false);
        expect(value.query).toBe('?secret=app-owned');
      }
      const bytes = Buffer.from([0, 255, 128, 10]);
      const signature = createHmac('sha256', providerKey)
        .update(bytes)
        .digest('hex');
      const provider = await hook(
        { 'X-Provider-Signature': signature },
        { body: bytes },
      );
      expect(provider.status).toBe(200);
      expectSanitized(
        (await provider.json()) as Record<string, unknown>,
        false,
      );
      expect(
        (
          await hook(
            { 'X-Provider-Signature': signature },
            { body: 'tampered' },
          )
        ).status,
      ).toBe(401);
      const cliDenied = await invoke(['--json']);
      expect(cliDenied.code).toBe(3);
      const cliAllowed = await invoke(
        ['--header', `X-App-Token: ${privateToken}`, '--json'],
        { credential: { apiKey: key } },
      );
      expect(cliAllowed.code).toBe(0);
      // Unsigned ingress continues streaming bodies beyond the signed 1 MiB cap.
      const large = await hook(
        { 'X-App-Token': privateToken },
        { suffix: '/binary', body: Buffer.alloc(1024 * 1024 + 1, 7) },
      );
      expect(large.status).toBe(201);
      expect(Buffer.from(await large.arrayBuffer())).toEqual(
        Buffer.alloc(1024 * 1024 + 1, 7),
      );
    }, 180000);
  },
);
