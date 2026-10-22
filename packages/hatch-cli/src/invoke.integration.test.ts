/** Opt-in installed-tarball contract against an isolated production Platform. */
import manifest from '../package.json' with { type: 'json' };
import { LATEST_APP_COMPATIBILITY_VERSION } from '~/app-compatibility';
import { spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.HATCH_INVOKE_TEST_DATABASE_URL;
const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, '../../..');
let root: string;
let binary: string;
let server: ChildProcess;
let origin: string;
let cookie: string;
let token: string;
let key: string;
let runToken: string;
let config: string;
let database: typeof import('~/db');
let serverOutput = '';
const cliProcesses = new Set<ChildProcess>();
const appId = `invoke-${randomUUID()}`;
const deploymentId = randomUUID();
const appSlug = `installed-${randomUUID()}`;
const secret = 'backend-invoke-production-fixture-secret-32-characters';

async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}
async function authCall(path: string, body: unknown) {
  const response = await fetch(`${origin}/api/auth/${path}`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      cookie: cookie ?? '',
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response;
}
async function cli(
  args: string[] = [],
  options: {
    env?: Record<string, string>;
    input?: string | Buffer;
    cancel?: boolean;
    profile?: boolean;
  } = {},
) {
  // Never inherit unrelated credentials, database URLs or fleet secrets.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        value !== undefined &&
        ['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].includes(name),
    ),
  ) as Record<string, string>;
  if (!options.profile)
    Object.assign(env, { HATCH_CLI_URL: origin, HATCH_CLI_TOKEN: token });
  Object.assign(env, options.env);
  const child = spawn(process.execPath, [binary, ...args], {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  cliProcesses.add(child);
  child.once('close', () => cliProcesses.delete(child));
  child.stdin.on('error', () => {});
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(options.input);
  const timer = options.cancel
    ? setTimeout(() => child.kill('SIGINT'), 600)
    : undefined;
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  const result = {
    code,
    stdout,
    stderr,
    data: stdout ? JSON.parse(stdout) : undefined,
  };
  const evidencePath = process.env.HATCH_INVOKE_TEST_EVIDENCE_PATH;
  if (evidencePath) {
    let transcript = JSON.stringify({
      args,
      outsideRepository: !root.startsWith(repository),
      code,
      stdout,
      stderr,
    });
    for (const credential of [token, key, runToken])
      if (credential)
        transcript = transcript.replaceAll(credential, '[redacted]');
    await appendFile(evidencePath, `${transcript}\n`);
  }
  return result;
}
const invoke = (method = 'Echo', extra: string[] = []) => [
  'app',
  'invoke',
  'backend',
  appSlug,
  `fixture.v1.EchoService/${method}`,
  ...extra,
  '--json',
];

// This URL must point to a fresh disposable PostgreSQL database, never a user DB.
describe.runIf(Boolean(databaseUrl))(
  'installed backend CLI on the real production runtime',
  () => {
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'hatch-installed-backend-'));
      const port = await freePort();
      const internalPort = await freePort();
      origin = `http://127.0.0.1:${port}`;
      process.env.DATABASE_URL = databaseUrl;
      process.env.APP_URL = origin;
      process.env.SECRET = secret;
      process.env.BETTER_AUTH_SECRET = secret;
      process.env.HATCH_DATA_DIR = join(root, 'runtime');
      database = await import('~/db');
      const { migrate } = await import('drizzle-orm/postgres-js/migrator');
      await migrate(database.db, {
        migrationsFolder: join(repository, 'migrations'),
      });
      server = spawn(
        process.execPath,
        [join(repository, 'dist/platform/server/index.mjs')],
        {
          cwd: repository,
          env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: String(port),
            AGENT_INTERNAL_PORT: String(internalPort),
            AGENT_RUNNER_TOKEN: 'fixture-server-only-fleet-secret',
          },
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      server.stdout!.on('data', (chunk) => {
        serverOutput += chunk;
      });
      server.stderr!.on('data', (chunk) => {
        serverOutput += chunk;
      });
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        ready = await fetch(`${origin}/api/auth/get-session`).then(
          (response) => response.ok,
          () => false,
        );
        if (ready) break;
        if (server.exitCode !== null)
          throw new Error('Production Platform exited');
        await delay(200);
      }
      if (!ready) throw new Error('Production Platform did not start');
      const signup = await authCall('sign-up/email', {
        name: 'Installed CLI owner',
        email: `${randomUUID()}@invoke.test`,
        password: 'Invoke-fixture-password-93',
      });
      cookie = signup.headers
        .getSetCookie()
        .map((header) => header.split(';')[0])
        .join('; ');
      const login = (await signup.json()) as {
        token: string;
        user: { id: string };
      };
      token = login.token;
      key = (
        (await (
          await authCall('api-key/create', {
            name: 'Installed backend fixture',
          })
        ).json()) as { key: string }
      ).key;
      const runId = randomUUID();
      const sessionId = randomUUID();
      await database.db
        .insert(database.schema.agentSessions)
        .values({ id: sessionId });
      await database.db.insert(database.schema.agentRuns).values({
        id: runId,
        sessionId,
        runnerId: 'fixture-runner',
        providerId: 'fixture',
        modelId: 'fixture',
        input: {},
        leaseExpiresAt: new Date(Date.now() + 600000),
      });
      const { auth } = await import('~auth/server');
      const now = Math.floor(Date.now() / 1000);
      runToken = (
        await auth.api.signJWT({
          body: {
            payload: {
              sub: runId,
              sid: sessionId,
              rnr: 'fixture-runner',
              iat: now,
              exp: now + 600,
            },
          },
        })
      ).token;
      await database.db.insert(database.schema.apps).values({
        id: appId,
        slug: appSlug,
        name: 'Installed fixture',
        status: 'deployed',
        currentDeploymentId: deploymentId,
        signingSecret: 'installed-app-fixture',
        capabilities: {
          backend: true,
          frontend: false,
          database: false,
          widgets: false,
          cron: false,
          webhook: false,
          kv: false,
        },
      });
      await database.db.insert(database.schema.deployments).values({
        id: deploymentId,
        appId,
        status: 'deployed',
        compatibilityVersion: LATEST_APP_COMPATIBILITY_VERSION,
      });
      const artifact = join(root, 'runtime/artifacts', appId, deploymentId);
      await mkdir(join(artifact, 'backend'), { recursive: true });
      await writeFile(
        join(artifact, 'deployment.json'),
        JSON.stringify({ deploymentId }),
      );
      await writeFile(
        join(artifact, 'manifest.normalized.json'),
        JSON.stringify({
          backend: {
            entry: 'backend/main.mjs',
            runtime: 'deno-serve',
            format: 'bundle-v1',
            network: [],
          },
        }),
      );
      await build({
        entryPoints: [
          join(repository, 'src/server/apps/test-fixtures/invoke-backend.ts'),
        ],
        outfile: join(artifact, 'backend/main.mjs'),
        platform: 'node',
        bundle: true,
        format: 'esm',
        target: 'es2022',
      });
      await exec('pnpm', ['pack', '--pack-destination', root], {
        cwd: join(repository, 'packages/hatch-cli'),
      });
      await writeFile(
        join(root, 'package.json'),
        '{"private":true,"type":"module"}\n',
      );
      await exec(
        'pnpm',
        [
          'add',
          join(root, `hatch-cli-${manifest.version}.tgz`),
          '--ignore-scripts',
        ],
        { cwd: root },
      );
      binary = join(root, 'node_modules/@hatch/cli/dist/main.mjs');
      const bundled = await readFile(binary, 'utf8');
      if (
        bundled.includes(repository) ||
        bundled.includes('fixture-server-only-fleet-secret')
      )
        throw new Error('CLI bundle contains private server inputs');
      config = join(root, 'config.json');
      await writeFile(
        config,
        JSON.stringify({
          version: 1,
          activeProfile: 'session',
          profiles: {
            session: { url: origin, token },
            key: { url: origin, apiKey: key },
          },
        }),
        { mode: 0o600 },
      );
    }, 120000);
    afterAll(async () => {
      for (const child of cliProcesses) child.kill('SIGTERM');
      if (server) {
        if (process.platform !== 'win32' && server.pid)
          process.kill(-server.pid, 'SIGTERM');
        else server.kill('SIGTERM');
        await Promise.race([once(server, 'exit'), delay(3000)]);
      }
      if (database) await database.db.$client.end();
      if (root) await rm(root, { recursive: true, force: true });
    });

    it('uses installed code outside the repo with session/key profiles and env session/key/Run credentials', async () => {
      for (const options of [
        { profile: true, args: ['--config', config, '--profile', 'session'] },
        { profile: true, args: ['--config', config, '--profile', 'key'] },
        { env: { HATCH_CLI_URL: origin, HATCH_CLI_TOKEN: token }, args: [] },
        {
          profile: true,
          env: { HATCH_CLI_URL: origin, HATCH_CLI_API_KEY: key },
          args: [],
        },
        { env: { HATCH_CLI_URL: origin, HATCH_CLI_TOKEN: runToken }, args: [] },
      ] as {
        profile?: boolean;
        args: string[];
        env?: Record<string, string>;
      }[]) {
        const result = await cli([...options.args, ...invoke()], options);
        expect(result.code).toBe(0);
        expect(result.data).toMatchObject({
          input: {},
          observed: { signatureValid: true, platformEnvPresent: false },
        });
        for (const name of ['cookie', 'authorization', 'x-api-key'])
          expect(result.data.observed.headers[name]).toBeUndefined();
      }
      const response = await fetch(
        `${origin}/api/app/${appId}/rpc/fixture.v1.EchoService/Echo`,
        {
          method: 'POST',
          headers: {
            cookie,
            origin,
            'content-type': 'application/json',
            'connect-protocol-version': '1',
          },
          body: '{}',
        },
      );
      expect(response.status).toBe(200);
    });

    it('preserves App JSON values and raw file/stdin bytes; resolves canonical IDs and workdir paths', async () => {
      for (const raw of [
        'null',
        'false',
        '0',
        '""',
        '[]',
        '{ "unicode": "你好", "empty": "", "false": false, "zero": 0 }',
      ]) {
        const result = await cli(invoke('Echo', ['--file', '-']), {
          input: raw,
        });
        expect(result.code).toBe(0);
        expect(result.data.input).toEqual(JSON.parse(raw));
        const identity = await cli(invoke('Identity', ['--file', '-']), {
          input: raw,
        });
        expect(identity.code).toBe(0);
        expect(identity.data).toEqual(JSON.parse(raw));
        expect(result.data.observed.rawBase64).toBe(
          Buffer.from(raw).toString('base64'),
        );
      }
      await mkdir(join(root, 'requests'));
      await writeFile(join(root, 'requests/body.json'), '{ "file": true }');
      const result = await cli([
        'app',
        'invoke',
        'backend',
        appId,
        'fixture.v1.EchoService/Echo',
        '--workdir',
        'requests',
        '--file',
        'body.json',
        '--json',
      ]);
      expect(result.code).toBe(0);
      expect(result.data.input).toEqual({ file: true });
    });

    it('reports real Connect errors/status and redacts actual credentials in error responses', async () => {
      const result = await cli(invoke('Fail', ['--file', '-']), {
        input: JSON.stringify({ reason: 'business failure', token }),
      });
      expect(result.code).toBe(6);
      expect(result.data).toMatchObject({
        ok: false,
        error: {
          code: 'failed_precondition',
          httpStatus: 400,
          response: {
            code: 'failed_precondition',
            details: [
              { type: 'google.protobuf.Value', value: expect.any(String) },
            ],
          },
        },
      });
      expect(result.stdout).not.toContain(token);
      expect(result.data.error.message).toContain('business failure');
      expect(result.data.error.message).toContain('[redacted]');
      const keyed = await cli(invoke('Fail', ['--file', '-']), {
        profile: true,
        env: { HATCH_CLI_URL: origin, HATCH_CLI_API_KEY: key },
        input: JSON.stringify({ reason: 'key failure', key }),
      });
      expect(keyed.code).toBe(6);
      expect(keyed.stdout).not.toContain(key);
      for (const method of ['Framed', 'Invalid', 'Redirect']) {
        const failed = await cli(invoke(method));
        expect(failed.code).toBe(7);
        expect(failed.data.error.code).toBe(
          {
            Invalid: 'invalid_response',
            Framed: 'unsupported_protocol',
            Redirect: 'outcome_unknown',
          }[method],
        );
      }
    });

    it('rejects bad input/methods and invalid env pairs without invoking a method or downgrading to a profile', async () => {
      for (const method of [
        'https://evil.test/a',
        '../Echo',
        'fixture.v1.EchoService%2fEcho',
        'fixture.v1.EchoService/Echo?x=1',
        'fixture.v1.EchoService/Echo#x',
        'fixture..Service/Echo',
        '/fixture.v1.EchoService/Echo',
        'fixture.v1.EchoService/../Echo',
        'fixture.v1.EchoService/Echo\n',
        'fixture.v1.EchoService%252fEcho',
        'fixture.v1.EchoService\\Echo',
      ]) {
        const result = await cli([
          'app',
          'invoke',
          'backend',
          appId,
          method,
          '--json',
        ]);
        expect(result.code).toBe(2);
        expect(result.data.error.code).toBe('invalid_arguments');
      }
      expect(
        (await cli(invoke('Echo', ['--file', '-']), { input: '{bad' })).data
          .error.code,
      ).toBe('invalid_input');
      const invalidUtf8 = await cli(invoke('Echo', ['--file', '-']), {
        input: Buffer.from([34, 255, 34]),
      });
      expect(invalidUtf8.data.error.code).toBe('invalid_input');
      const oversized = await cli(invoke('Echo', ['--file', '-']), {
        input: JSON.stringify('中'.repeat(350000)),
      });
      expect(oversized.data.error.code).toBe('input_too_large');
      for (const env of [
        { HATCH_CLI_URL: origin },
        { HATCH_CLI_URL: origin, HATCH_CLI_TOKEN: '' },
        {
          HATCH_CLI_URL: origin,
          HATCH_CLI_API_KEY: key,
          HATCH_CLI_TOKEN: token,
        },
      ] as Record<string, string>[]) {
        const result = await cli([...invoke(), '--config', config], {
          profile: true,
          env,
        });
        expect(result.code).toBe(2);
        expect(result.data.error.code).toBe('incomplete_env');
      }
      expect(
        (await cli([...invoke(), '--profile', 'key', '--config', config])).data
          .error.code,
      ).toBe('source_conflict');
      const rejected = await cli([...invoke(), '--config', config], {
        env: { HATCH_CLI_TOKEN: 'invalid-session' },
      });
      expect(rejected.code).toBe(3);
    });

    it('handles network failure, timeout, SIGINT and honest help without retries', async () => {
      const network = await cli(invoke(), {
        env: { HATCH_CLI_URL: 'http://127.0.0.1:1' },
      });
      expect(network.code).toBe(7);
      const before = await cli(invoke());
      const slowCalls =
        before.data.observed.calls['/fixture.v1.EchoService/Slow'] ?? 0;
      const timedOut = await cli(invoke('Slow', ['--timeout', '0.2']));
      expect(timedOut.code).toBe(7);
      expect(timedOut.data.error.code).toBe('outcome_unknown');
      const cancelled = await cli(invoke('Slow'), { cancel: true });
      expect(cancelled.code).toBe(130);
      expect(cancelled.data.error.code).toBe('cancelled');
      const after = await cli(invoke());
      expect(after.data.observed.calls['/fixture.v1.EchoService/Slow']).toBe(
        slowCalls + 2,
      );
      expect(after.data.observed.cancellations).toBeGreaterThan(
        before.data.observed.cancellations,
      );
      const help = await cli(['app', 'invoke', 'backend', '--help', '--json']);
      expect(help.code).toBe(0);
      expect(help.data.commands).toMatchObject([
        { path: ['app', 'invoke', 'backend'], supported: true },
      ]);
      expect(help.data.commands[0].description).toContain('unary JSON');
      expect(serverOutput).not.toContain(token);
      expect(serverOutput).not.toContain(key);
      expect(serverOutput).not.toContain(runToken);
    });
  },
);
