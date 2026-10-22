import { connectNodeAdapter } from '@connectrpc/connect-node';
import { Code, ConnectError } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { AuthService } from '../../hatch-platform-api/gen/hatch/platform/v1/auth_pb';
import { PublicErrorSchema } from '../../hatch-platform-api/gen/hatch/platform/v1/error_pb';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  mkdir,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
const sessionToken = 'fixture-session-secret';
const runToken = 'fixture.run.secret';
let directory: string;
let config: string;
let origin: string;
let statusCode = 200;
let wrongCredentialType = false;
let deviceDecision = 'approved';
let polls = 0;
let onSignOut: (() => Promise<void>) | undefined;
let calls: string[] = [];
const expiresAt = '2099-01-01T00:00:00.000Z';
const sessionStatus = {
  authenticated: true,
  credentialType: 'session',
  authority: 'platform',
  expiresAt,
  user: { id: 'user-1', email: 'owner@example.test', name: 'Owner' },
};

const rpc = connectNodeAdapter({
  requestPathPrefix: '/api/rpc',
  routes: (router) =>
    router.service(AuthService, {
      getStatus: (_input, context) => {
        if (statusCode !== 200)
          throw new ConnectError(
            sessionToken,
            Code.Unauthenticated,
            undefined,
            [
              {
                desc: PublicErrorSchema,
                value: create(PublicErrorSchema, {
                  code: 'UNAUTHORIZED',
                  httpStatus: statusCode,
                }),
              },
            ],
          );
        const user = sessionStatus.user;
        if (
          wrongCredentialType ||
          context.requestHeader.get('authorization') ===
            `Bearer ${sessionToken}`
        )
          return {
            expiresAt,
            credential: { case: 'session', value: { user } },
          };
        if (context.requestHeader.get('x-api-key') === 'fixture-key-secret')
          return {
            credential: {
              case: 'apiKey',
              value: { user, id: 'key-1', name: 'Fixture' },
            },
          };
        if (context.requestHeader.get('authorization') === `Bearer ${runToken}`)
          return {
            expiresAt,
            credential: {
              case: 'run',
              value: {
                runId: 'run-1',
                sessionId: 'session-1',
                runnerId: 'runner-1',
              },
            },
          };
        throw new ConnectError('Unauthorized', Code.Unauthenticated);
      },
    }),
});
const server = createServer(async (incoming, outgoing) => {
  calls.push(`${incoming.method} ${incoming.url}`);
  if (incoming.url?.startsWith('/api/rpc/')) {
    if (statusCode === 302) {
      outgoing.writeHead(302, { location: `${origin}/credential-leak` });
      outgoing.end();
    } else await rpc(incoming, outgoing);
    return;
  }
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const body = chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString())
    : {};
  const send = (value: unknown, code = 200) => {
    outgoing.writeHead(code, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify(value));
  };
  if (incoming.url === '/api/auth/sign-out') {
    await onSignOut?.();
    send({ success: true });
  } else if (incoming.url === '/api/auth/device/code') {
    assert.equal(body.client_id, 'hatch-cli');
    send({
      device_code: 'fixture-device-secret',
      user_code: 'ABCD1234',
      interval: 0.02,
      expires_in: 10,
      verification_uri_complete: `${deviceDecision === 'other-instance' ? 'https://other.example.test' : origin}/cli/authorize?user_code=ABCD1234`,
    });
  } else if (incoming.url === '/api/auth/device/token') {
    assert.equal(
      body.grant_type,
      'urn:ietf:params:oauth:grant-type:device_code',
    );
    polls++;
    if (['approved', 'run'].includes(deviceDecision) && polls > 1)
      send({
        access_token: deviceDecision === 'run' ? runToken : sessionToken,
      });
    else if (deviceDecision === 'denied') send({ error: 'access_denied' }, 400);
    else if (deviceDecision === 'expired')
      send({ error: 'expired_token' }, 400);
    else if (deviceDecision === 'slow') send({ error: 'slow_down' }, 400);
    else send({ error: 'authorization_pending' }, 400);
  } else send({ error: 'not_found' }, 404);
});

async function invoke(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  const env = { ...process.env, ...options.env };
  delete env.HATCH_CLI_URL;
  delete env.HATCH_CLI_TOKEN;
  delete env.HATCH_CLI_API_KEY;
  delete env.FORCE_COLOR;
  Object.assign(env, options.env);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', entry, ...args],
        { env, stdio: 'pipe' },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    },
  );
}

async function stored(token = sessionToken) {
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      activeProfile: 'local',
      profiles: {
        local: { url: origin, token },
        other: { url: 'https://other.example.test', token: 'other-secret' },
      },
    }),
    { mode: 0o600 },
  );
}

describe('CLI authentication boundary', () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No test server address');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hatch-cli-test-'));
    config = join(directory, 'config.json');
    statusCode = 200;
    wrongCredentialType = false;
    deviceDecision = 'approved';
    polls = 0;
    calls = [];
    onSignOut = undefined;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('saves a browser-approved session privately and preserves other profiles', async () => {
    await stored();
    const result = await invoke([
      'auth',
      'login',
      '--url',
      origin,
      '--no-browser',
      '--profile',
      'new',
      '--config',
      config,
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      source: 'config',
      profile: 'new',
      ...sessionStatus,
    });
    expect(result.stdout + result.stderr).not.toContain(sessionToken);
    const saved = JSON.parse(await readFile(config, 'utf8'));
    expect(saved.profiles.other.url).toBe('https://other.example.test');
    expect(saved.profiles.new).toEqual({ url: origin, token: sessionToken });
    if (process.platform !== 'win32')
      assert.equal((await stat(config)).mode & 0o777, 0o600);
    const status = await invoke([
      '--profile',
      'new',
      'auth',
      'status',
      '--config',
      config,
      '--json',
    ]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).user.email).toBe('owner@example.test');
  });

  it('completes headless device login without displaying the redeemed token', async () => {
    const result = await invoke([
      'auth',
      'login',
      '--url',
      origin,
      '--no-browser',
      '--config',
      config,
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(polls).toBe(2);
    expect(result.stderr).toContain('ABCD1234');
    expect(result.stdout + result.stderr).not.toContain(
      'fixture-device-secret',
    );
    expect(result.stdout + result.stderr).not.toContain(sessionToken);
    expect(
      JSON.parse(await readFile(config, 'utf8')).profiles.default.url,
    ).toBe(origin);
  });

  it.skipIf(process.platform === 'win32')(
    'launches only the verification URL, without inheriting host credentials',
    async () => {
      const bin = join(directory, 'bin');
      await mkdir(bin);
      await writeFile(
        join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open'),
        '#!/usr/bin/env node\n' +
          "require('node:fs').writeFileSync(require('node:path').join(process.env.HOME, 'browser.json'), JSON.stringify({ args: process.argv.slice(2), secret: process.env.AGENT_RUNNER_TOKEN }));\n",
        { mode: 0o755 },
      );
      const result = await invoke(
        ['auth', 'login', '--url', origin, '--config', config],
        {
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: directory,
            AGENT_RUNNER_TOKEN: 'fake-host-secret',
          },
        },
      );
      expect(result.code).toBe(0);
      expect(
        JSON.parse(await readFile(join(directory, 'browser.json'), 'utf8')),
      ).toEqual({ args: [`${origin}/cli/authorize?user_code=ABCD1234`] });
    },
  );

  // Windows kill(SIGINT) force-terminates a child; it is not a console Ctrl+C.
  it.skipIf(process.platform === 'win32')(
    'cancels pending device login without saving credentials',
    async () => {
      deviceDecision = 'pending';
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          entry,
          'auth',
          'login',
          '--url',
          origin,
          '--no-browser',
          '--config',
          config,
        ],
        {
          env: {
            ...process.env,
            HATCH_CLI_URL: undefined,
            HATCH_CLI_TOKEN: undefined,
          },
          stdio: 'pipe',
        },
      );
      const code = await new Promise<number | null>((resolve, reject) => {
        child.stderr.on('data', (chunk) => {
          if (String(chunk).includes('Code:')) child.kill('SIGINT');
        });
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(code).toBe(130);
      await expect(stat(config)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('uses the env pair without reading even a corrupt config, and verifies Run context', async () => {
    await writeFile(config, 'broken configuration');
    const result = await invoke(
      ['auth', 'status', '--config', config, '--json'],
      {
        env: { HATCH_CLI_URL: origin, HATCH_CLI_TOKEN: runToken },
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      source: 'env',
      credentialType: 'run',
      context: { runId: 'run-1' },
    });
    expect(result.stdout + result.stderr).not.toContain(runToken);
    expect(await readFile(config, 'utf8')).toBe('broken configuration');
  });

  it('rejects partial/empty env and explicit profile mixing without a request or fallback', async () => {
    await stored();
    for (const env of [
      { HATCH_CLI_URL: origin },
      { HATCH_CLI_TOKEN: sessionToken },
      { HATCH_CLI_URL: origin, HATCH_CLI_TOKEN: '' },
    ]) {
      expect(
        (await invoke(['auth', 'status', '--config', config], { env })).code,
      ).toBe(2);
    }
    const result = await invoke(
      ['auth', 'status', '--profile', 'local', '--config', config],
      {
        env: { HATCH_CLI_URL: origin, HATCH_CLI_TOKEN: sessionToken },
      },
    );
    expect(result.code).toBe(2);
    expect(calls).toEqual([]);
  });

  it('does not fall back from invalid env, forward a redirect, or echo server error text', async () => {
    await stored();
    statusCode = 401;
    const result = await invoke(
      ['auth', 'status', '--config', config, '--json'],
      {
        env: { HATCH_CLI_URL: origin, HATCH_CLI_TOKEN: sessionToken },
      },
    );
    expect(result.code).toBe(3);
    expect(result.stdout + result.stderr).not.toContain(sessionToken);
    expect(calls).toHaveLength(1);
    statusCode = 302;
    expect((await invoke(['auth', 'status', '--config', config])).code).toBe(7);
    expect(calls).not.toContain('GET /credential-leak');
  });

  it('refuses to persist env credentials or a non-session device result', async () => {
    const injected = await invoke(
      ['auth', 'login', '--url', origin, '--config', config],
      {
        env: { HATCH_CLI_URL: origin, HATCH_CLI_TOKEN: sessionToken },
      },
    );
    expect(injected.code).toBe(2);
    expect(calls).toHaveLength(0);
    deviceDecision = 'run';
    const run = await invoke([
      'auth',
      'login',
      '--url',
      origin,
      '--no-browser',
      '--config',
      config,
      '--json',
    ]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout).error.code).toBe('run_token_not_persisted');
    await expect(stat(config)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves existing configuration when approval fails or login expires', async () => {
    await stored();
    const before = await readFile(config, 'utf8');
    for (const [decision, expected] of [
      ['denied', 4],
      ['expired', 3],
      ['other-instance', 2],
    ] as const) {
      deviceDecision = decision;
      const result = await invoke([
        'auth',
        'login',
        '--url',
        origin,
        '--no-browser',
        '--config',
        config,
      ]);
      expect(result.code).toBe(expected);
      expect(await readFile(config, 'utf8')).toBe(before);
    }
  });

  it('honors slow_down and a bounded wait instead of polling in a tight loop', async () => {
    deviceDecision = 'slow';
    const result = await invoke([
      'auth',
      'login',
      '--url',
      origin,
      '--no-browser',
      '--timeout',
      '5',
      '--config',
      config,
    ]);
    expect(result.code).toBe(7);
    expect(polls).toBe(1);
    await expect(stat(config)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15000);

  it('fails closed for unsafe files and concurrent login writes', async () => {
    await stored();
    const before = await readFile(config, 'utf8');
    await mkdir(`${config}.lock`);
    const result = await invoke([
      'auth',
      'login',
      '--url',
      origin,
      '--no-browser',
      '--config',
      config,
    ]);
    expect(result.code).toBe(6);
    expect(await readFile(config, 'utf8')).toBe(before);
    if (process.platform !== 'win32') {
      await chmod(config, 0o644);
      assert.equal(
        (await invoke(['auth', 'status', '--config', config])).code,
        2,
      );
    }
    await rm(directory, { recursive: true, force: true });
  });

  it('shows help without credentials', async () => {
    const help = await invoke(['--json', '--help'], {
      env: { HATCH_CLI_TOKEN: 'partial-env' },
    });
    expect(help.code).toBe(0);
    expect(JSON.parse(help.stdout).version).toBe('0.1.0');
    expect(calls).toEqual([]);
  });

  // Keep one CLI startup per case so slower hosts do not share a timeout.
  it.each([
    { args: ['auth', 'key', 'list'] },
    { args: ['operation', 'get', 'operation-1'] },
    { args: ['auth', 'key', '--help'] },
    { args: ['operation', '--help'] },
    { args: ['help', 'auth', 'key'] },
    { args: ['help', 'operation'] },
  ])('rejects removed command $args as unknown', async ({ args }) => {
    const result = await invoke([...args, '--json']);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe('unknown_command');
    expect(calls).toEqual([]);
  });

  it.each([
    { args: ['auth', 'login', '--token-stdin'] },
    { args: ['--workdir', '.', 'auth', 'status'] },
  ])(
    'rejects invalid arguments $args without authentication',
    async ({ args }) => {
      const result = await invoke([...args, '--json']);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).error.code).toBe('invalid_arguments');
      expect(calls).toEqual([]);
    },
  );

  it('reports a credential-type mismatch without saving or replacing a profile', async () => {
    await stored();
    const before = await readFile(config, 'utf8');
    const key = join(directory, 'key');
    await writeFile(key, 'fixture-key-secret', { mode: 0o600 });
    wrongCredentialType = true;
    const result = await invoke([
      'auth',
      'login',
      '--url',
      origin,
      '--api-key-file',
      key,
      '--config',
      config,
      '--json',
    ]);
    expect(JSON.parse(result.stdout).error.code).toBe(
      'credential_type_mismatch',
    );
    expect(result.code).toBe(2);
    expect(await readFile(config, 'utf8')).toBe(before);
    expect(result.stdout + result.stderr).not.toContain('fixture-key-secret');
  });

  it('uses API keys with their own header and preserves the config/env boundary', async () => {
    const key = join(directory, 'key');
    await writeFile(key, 'fixture-key-secret', { mode: 0o600 });
    const login = await invoke([
      'auth',
      'login',
      '--url',
      origin,
      '--api-key-file',
      key,
      '--config',
      config,
      '--json',
    ]);
    expect(login.code).toBe(0);
    expect(JSON.parse(login.stdout).credentialType).toBe('api-key');
    expect(login.stdout + login.stderr).not.toContain('fixture-key-secret');
    const saved = JSON.parse(await readFile(config, 'utf8'));
    expect(saved.profiles.default).toEqual({
      url: origin,
      apiKey: 'fixture-key-secret',
    });
    const status = await invoke(['auth', 'status', '--json'], {
      env: { HATCH_CLI_URL: origin, HATCH_CLI_API_KEY: 'fixture-key-secret' },
    });
    expect(status.code).toBe(0);
    const conflict = await invoke(['auth', 'status', '--config', config], {
      env: {
        HATCH_CLI_URL: origin,
        HATCH_CLI_API_KEY: 'fixture-key-secret',
        HATCH_CLI_TOKEN: sessionToken,
      },
    });
    expect(conflict.code).toBe(2);
    expect((await invoke(['auth', 'logout', '--config', config])).code).toBe(2);
    const local = await invoke([
      'auth',
      'logout',
      '--local-only',
      '--config',
      config,
      '--json',
    ]);
    expect(JSON.parse(local.stdout)).toMatchObject({
      removed: true,
      revoked: false,
    });
    expect(JSON.parse(await readFile(config, 'utf8')).profiles).toEqual({});
  });

  it('confirms session revocation before local removal, and retains profiles on failure', async () => {
    await stored();
    const before = await readFile(config, 'utf8');
    statusCode = 401;
    expect((await invoke(['auth', 'logout', '--config', config])).code).toBe(3);
    expect(await readFile(config, 'utf8')).toBe(before);
    statusCode = 200;
    const result = await invoke([
      'auth',
      'logout',
      '--config',
      config,
      '--json',
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      removed: true,
      revoked: true,
    });
    const saved = JSON.parse(await readFile(config, 'utf8'));
    expect(saved.profiles.local).toBeUndefined();
    expect(saved.profiles.other.url).toBe('https://other.example.test');
  });
  it('preserves a re-login that races session logout', async () => {
    await stored();
    onSignOut = () => stored('newly-saved-session');
    const result = await invoke([
      'auth',
      'logout',
      '--config',
      config,
      '--json',
    ]);
    expect(result.code).toBe(6);
    expect(JSON.parse(result.stdout).error.code).toBe('config_changed');
    expect(
      JSON.parse(await readFile(config, 'utf8')).profiles.local.token,
    ).toBe('newly-saved-session');
  });
});
