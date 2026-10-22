/** Opt-in end-to-end contract using disposable DB and production bundles. */
import assert from 'node:assert/strict';
import postgres from 'postgres';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  copyFile,
  chmod,
  realpath,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rpcCall } from '../server/platform-api/test-client';

const databaseUrl = process.env.HATCH_RUNNER_CLI_TEST_DATABASE_URL;
const testDatabaseName = `runner_cli_${randomUUID().replaceAll('-', '')}`;
let databaseAdmin: ReturnType<typeof postgres>;
const evidenceDir = process.env.HATCH_RUNNER_CLI_TEST_EVIDENCE_DIR;
const fleet = `disposable-fleet-${randomUUID()}`;
const secret = `disposable-platform-${randomUUID()}`;
const runnerId = `cli-runner-${randomUUID()}`;
let root: string;
let origin: string;
let internal: string;
let fixtureUrl: string;
let cookie: string;
let platform: ChildProcess;
let runner: ChildProcess;
let fixture: http.Server;
let controlProxy: http.Server;
const controlSockets = new Set<net.Socket>();
let acceptControl = true;
let database: typeof import('~/db');
let providerId: string;
let platformLog = '';
let runnerLog = '';
let modelRequests = '';
const observations: string[] = [];
type Capture = {
  token: string;
  endpoint: string;
  key: string;
  safeEnv: boolean;
};
const captures = new Map<string, Capture>();
const held = new Map<string, http.ServerResponse>();
const commands = new Map<string, string[]>();

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function until<T>(
  fn: () => Promise<T | undefined | false>,
  label: string,
  timeout = 60000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function json(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, value: text ? JSON.parse(text) : null };
}
function script(label: string, renew: boolean, finishWithoutCli = false) {
  const source = `
    const { execFileSync } = require('node:child_process');
    const capture = async (stage) => {
      await fetch(${JSON.stringify(fixtureUrl)} + '/capture/' + ${JSON.stringify(label)} + '/' + stage, {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({token:process.env.HATCH_CLI_TOKEN,endpoint:process.env.HATCH_CLI_RUN_ENDPOINT,key:process.env.HATCH_CLI_RUN_SECRET,
          safeEnv: !process.env.AGENT_RUNNER_TOKEN && !process.env.DATABASE_URL && !process.env.SECRET && !process.env.BETTER_AUTH_SECRET && !process.env.HATCH_CLI_API_KEY})
      });
    };
    const cli = (args, input) => {
      const output = execFileSync('hatch', [...args, '--json'], { encoding:'utf8', input });
      console.log(output.trim());
    };
    (async () => {
      await capture('start');
      console.log(process.env.HATCH_CLI_TOKEN);
      cli(['auth','status']); cli(['app','list']); cli(['workflow','list']);
      ${
        renew
          ? `cli(['workflow','create','--file','-','--directory','./disposable-workflow'], JSON.stringify({slug:${JSON.stringify(`runner-cli-${randomUUID()}`)},name:'Runner CLI acceptance'}));
      await new Promise(r=>setTimeout(r,7000));
      cli(['auth','status']); cli(['app','list']); cli(['workflow','list']);`
          : ''
      }
      await capture('ready');
      ${finishWithoutCli ? '' : "cli(['auth','status']);"}
    })().catch(() => {console.error('CLI fixture failed');process.exitCode=1});
  `;
  return `node -e '${source.replaceAll("'", "'\\''")}'`;
}
async function start(label: string, renew = false) {
  const [session] = await database.db
    .insert(database.schema.agentSessions)
    .values({})
    .returning();
  commands.set(label, [
    script(label, renew),
    ['renew', 'concurrent'].includes(label)
      ? script(`${label}-final`, false, true)
      : 'hatch auth status --json',
  ]);
  const result = await json(
    `${origin}/api/agent/runs`,
    {
      sessionId: session.id,
      providerId,
      modelId: 'fixture-cli-model',
      content: [{ type: 'text', text: `runner-cli-probe:${label}` }],
    },
    { cookie, origin },
  );
  assert.equal(result.response.status, 200, 'Real scheduling request failed.');
  return { sessionId: session.id, runId: result.value.runId as string, label };
}
async function ready(label: string) {
  return until(async () => held.get(label), `${label} command ready`);
}
function release(label: string) {
  held.get(label)?.end('{}');
  held.delete(label);
}
async function getFresh(label: string) {
  const captured = captures.get(label)!;
  const result = await json(
    captured.endpoint,
    {},
    { authorization: `Bearer ${captured.key}` },
  );
  assert.equal(result.response.status, 200, 'Fresh native Run token missing.');
  return result.value.token as string;
}
async function status(token: string) {
  return rpcCall(origin, 'auth/status', { authorization: `Bearer ${token}` });
}
async function terminal(runId: string) {
  return until(async () => {
    const run = await database.db.query.agentRuns.findFirst({
      where: { id: runId },
    });
    return run && !['running', 'blocked'].includes(run.status)
      ? run
      : undefined;
  }, 'Run termination');
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return;
  const stopped = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await stopped;
  clearTimeout(timer);
}
async function allFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await allFiles(file)));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

describe.runIf(Boolean(databaseUrl))(
  'Runner-installed CLI on an isolated real Platform',
  () => {
    beforeAll(async () => {
      root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'hatch-runner-cli-')),
      );
      await mkdir(path.join(root, 'bin'));
      await copyFile(
        'packages/hatch-cli/dist/main.mjs',
        path.join(root, 'bin/hatch'),
      );
      await chmod(path.join(root, 'bin/hatch'), 0o755);
      origin = `http://127.0.0.1:${await freePort()}`;
      internal = `http://127.0.0.1:${await freePort()}`;
      fixture = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        if (req.url?.startsWith('/capture/')) {
          const [, , label, stage] = req.url.split('/');
          captures.set(label, JSON.parse(raw));
          if (stage === 'ready') held.set(label, res);
          else res.end('{}');
          return;
        }
        modelRequests += raw;
        const body = JSON.parse(raw);
        const messages = body.messages as Array<{
          role: string;
          content: unknown;
        }>;
        let lastUser = messages.length - 1;
        while (lastUser >= 0 && messages[lastUser].role !== 'user') lastUser--;
        const label =
          /runner-cli-probe:([\w-]+)/.exec(
            JSON.stringify(messages[lastUser]),
          )?.[1] ?? '';
        const toolCount = messages
          .slice(lastUser)
          .filter((item) => item.role === 'tool').length;
        const command = commands.get(label)?.[toolCount];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: unknown, finishReason: string | null) => {
          res.write(
            `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture-cli-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
          );
        };
        if (command) {
          chunk(
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${randomUUID()}`,
                  type: 'function',
                  function: {
                    name: 'run_command',
                    arguments: JSON.stringify({
                      purpose: 'Verify installed CLI',
                      command,
                    }),
                  },
                },
              ],
            },
            null,
          );
          chunk({}, 'tool_calls');
        } else {
          chunk({ role: 'assistant', content: 'CLI probe complete.' }, null);
          chunk({}, 'stop');
        }
        res.end('data: [DONE]\n\n');
      });
      fixture.listen(0, '127.0.0.1');
      await once(fixture, 'listening');
      fixtureUrl = `http://127.0.0.1:${(fixture.address() as net.AddressInfo).port}`;
      const isolatedDatabaseUrl = new URL(databaseUrl!);
      assert(
        ['127.0.0.1', 'localhost', '[::1]'].includes(
          isolatedDatabaseUrl.hostname,
        ),
        'The test database must be on a disposable loopback server.',
      );
      databaseAdmin = postgres(databaseUrl!, { max: 1 });
      await databaseAdmin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
      isolatedDatabaseUrl.pathname = `/${testDatabaseName}`;
      Object.assign(process.env, {
        DATABASE_URL: isolatedDatabaseUrl.toString(),
        APP_DATABASE_URL: isolatedDatabaseUrl.toString(),
        APP_URL: origin,
        SECRET: secret,
        BETTER_AUTH_SECRET: secret,
        HATCH_DATA_DIR: path.join(root, 'platform'),
      });
      database = await import('~/db');
      const { migrate } = await import('drizzle-orm/postgres-js/migrator');
      await migrate(database.db, { migrationsFolder: 'migrations' });
      const [provider] = await database.db
        .insert(database.schema.agentProviders)
        .values({
          name: 'Deterministic CLI fixture',
          apiType: 'openai-completions',
          baseUrl: `${fixtureUrl}/v1`,
          apiKey: 'fixture-provider-only',
        })
        .returning();
      providerId = provider.id;
      await database.db.insert(database.schema.agentModels).values({
        providerId,
        modelId: 'fixture-cli-model',
        name: 'CLI fixture model',
      });
      platform = spawn(process.execPath, ['dist/platform/server/index.mjs'], {
        env: {
          ...process.env,
          NODE_ENV: 'production',
          HOST: '127.0.0.1',
          PORT: new URL(origin).port,
          AGENT_INTERNAL_HOST: '127.0.0.1',
          AGENT_INTERNAL_PORT: new URL(internal).port,
          AGENT_RUNNER_TOKEN: fleet,
          HATCH_RUN_TOKEN_TTL_SECONDS: '5',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      platform.stdout?.on('data', (chunk) => {
        platformLog += chunk;
      });
      platform.stderr?.on('data', (chunk) => {
        platformLog += chunk;
      });
      await until(async () => {
        try {
          return (await fetch(`${origin}/api/auth/ok`)).ok;
        } catch {
          return false;
        }
      }, 'Platform startup');
      const signup = await json(
        `${origin}/api/auth/sign-up/email`,
        {
          email: `${randomUUID()}@runner.test`,
          password: 'disposable-runner-test-password',
          name: 'Disposable owner',
        },
        { origin },
      );
      assert.equal(signup.response.status, 200, 'Fixture owner signup failed.');
      cookie = signup.response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      controlProxy = http.createServer((req, res) => {
        const upstream = http.request(
          new URL(req.url ?? '/', internal),
          {
            method: req.method,
            headers: req.headers,
          },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
          },
        );
        upstream.on('error', () => res.writeHead(503).end());
        req.pipe(upstream);
      });
      controlProxy.on('connection', (socket) => {
        controlSockets.add(socket);
        socket.once('close', () => controlSockets.delete(socket));
      });
      controlProxy.on('upgrade', (req, socket, head) => {
        if (!acceptControl) {
          socket.destroy();
          return;
        }
        const upstream = http.request(new URL(req.url ?? '/', internal), {
          headers: req.headers,
        });
        upstream.on('upgrade', (response, peer, peerHead) => {
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
              Object.entries(response.headers)
                .map(([key, value]) => `${key}: ${value}`)
                .join('\r\n') +
              '\r\n\r\n',
          );
          if (head.length) peer.write(head);
          if (peerHead.length) socket.write(peerHead);
          peer.pipe(socket);
          socket.pipe(peer);
          peer.on('error', () => socket.destroy());
          socket.on('error', () => peer.destroy());
          socket.once('close', () => peer.destroy());
        });
        upstream.on('error', () => socket.destroy());
        upstream.end();
      });
      controlProxy.listen(0, '127.0.0.1');
      await once(controlProxy, 'listening');
      const controlUrl = `http://127.0.0.1:${(controlProxy.address() as net.AddressInfo).port}`;
      runner = spawn(process.execPath, ['dist/runner/main.mjs'], {
        // Deliberately omit all Platform credentials from the Runner environment.
        env: {
          PATH: `${root}/bin:${process.env.PATH}`,
          APP_URL: origin,
          HATCH_PLATFORM_URL: controlUrl,
          HATCH_RUNNER_CLI_URL: origin,
          AGENT_RUNNER_TOKEN: fleet,
          HATCH_RUNNER_ID: runnerId,
          HATCH_DATA_DIR: path.join(root, 'runner'),
          NODE_ENV: 'production',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      runner.stdout?.on('data', (chunk) => {
        runnerLog += chunk;
      });
      runner.stderr?.on('data', (chunk) => {
        runnerLog += chunk;
      });
      await until(
        async () => runnerLog.includes('[runner] connected to'),
        'Runner control handshake',
      );
    }, 60000);

    afterAll(async () => {
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        let diagnostic = platformLog + '\n' + runnerLog;
        if (database) {
          const runs = await database.db.query.agentRuns.findMany();
          const events = await database.db.query.agentRunEvents.findMany();
          diagnostic +=
            '\n' +
            JSON.stringify(
              {
                runs: runs.map(({ id, status, error }) => ({
                  id,
                  status,
                  error,
                })),
                events: events
                  .filter(
                    (event) =>
                      (event.payload as Record<string, unknown>).type ===
                      'tool_end',
                  )
                  .map((event) => event.payload),
              },
              null,
              2,
            );
        }
        diagnostic = diagnostic.replace(
          /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
          '[redacted]',
        );
        for (const value of [
          fleet,
          secret,
          ...[...captures.values()].flatMap((item) => [item.token, item.key]),
        ])
          diagnostic = diagnostic.replaceAll(value, '[redacted]');
        await writeFile(path.join(evidenceDir, 'diagnostic.log'), diagnostic);
      }
      for (const response of held.values()) response.end('{}');
      await stop(runner);
      await stop(platform);
      controlProxy?.closeAllConnections();
      controlProxy?.close();
      for (const socket of controlSockets) socket.destroy();
      fixture?.closeAllConnections();
      fixture?.close();
      await database?.db.$client.end({ timeout: 1 });
      if (databaseAdmin) {
        await databaseAdmin.unsafe(
          `DROP DATABASE IF EXISTS "${testDatabaseName}" WITH (FORCE)`,
        );
        await databaseAdmin.end();
      }
      if (root) await rm(root, { recursive: true, force: true });
    }, 30000);

    it('renews across expiry, isolates identities, rejects stale authority and leaves no credentials behind', async () => {
      const [a, b] = await Promise.all([
        start('renew', true),
        start('concurrent'),
      ]);
      await Promise.all([ready(a.label), ready(b.label)]);
      const ca = captures.get(a.label)!;
      const cb = captures.get(b.label)!;
      assert(
        ca.safeEnv && cb.safeEnv,
        'A command inherited a Platform/fleet secret.',
      );
      assert(
        ca.token !== cb.token &&
          ca.key !== cb.key &&
          ca.endpoint !== cb.endpoint,
        'Concurrent command credentials were shared.',
      );
      expect(
        (await json(ca.endpoint, {}, { authorization: `Bearer ${cb.key}` }))
          .response.status,
      ).toBe(403);
      // The first shell is still active, but its original native JWT has expired.
      expect((await status(ca.token)).response.ok).toBe(false);
      const [freshA, freshB] = await Promise.all([
        getFresh(a.label),
        getFresh(b.label),
      ]);
      expect((await status(freshA)).data.context).toEqual({
        runId: a.runId,
        sessionId: a.sessionId,
        runnerId,
      });
      expect((await status(freshB)).data.context).toEqual({
        runId: b.runId,
        sessionId: b.sessionId,
        runnerId,
      });
      observations.push(
        'Concurrent real Runs received distinct identities and renewed after native five-second expiry within one shell.',
      );
      release(a.label);
      release(b.label);
      await Promise.all([ready(`${a.label}-final`), ready(`${b.label}-final`)]);
      const endToken = await getFresh(`${a.label}-final`);
      const endExpiry = Date.parse((await status(endToken)).data.expiresAt);
      release(`${a.label}-final`);
      release(`${b.label}-final`);
      expect((await terminal(a.runId)).status).toBe('completed');
      expect((await terminal(b.runId)).status).toBe('completed');
      expect((await status(endToken)).response.ok).toBe(false);
      expect(endExpiry).toBeGreaterThan(Date.now());
      await expect(fetch(ca.endpoint)).rejects.toThrow('fetch failed');
      const session = await database.db.query.agentSessions.findFirst({
        where: { id: a.sessionId },
      });
      const transcript = JSON.stringify(session?.messages);
      expect(transcript).toContain('credentialType');
      expect(transcript).toContain('Runner CLI acceptance');
      expect(
        await database.db.query.workflows.findMany({
          where: { name: 'Runner CLI acceptance' },
        }),
      ).toHaveLength(1);
      const events = await database.db.query.agentRunEvents.findMany({
        where: { runId: a.runId },
      });
      const commandEnds = events
        .map((event) => event.payload as Record<string, unknown>)
        .filter((event) => event.type === 'tool_end');
      expect(commandEnds).toHaveLength(2);
      expect(
        commandEnds.every(
          (event) =>
            event.isError !== true &&
            (event.details as { exitCode?: number })?.exitCode === 0,
        ),
      ).toBe(true);
      observations.push(
        'Installed CLI auth status, App/Workflow reads, Workflow creation and a later command succeeded; ended tokens and command channels were rejected.',
      );

      const resumed = await start('reconnected');
      await ready(resumed.label);
      const reconnectCapture = captures.get(resumed.label)!;
      const logOffset = runnerLog.length;
      acceptControl = false;
      for (const socket of controlSockets) socket.destroy();
      await until(
        async () => runnerLog.slice(logOffset).includes('connection closed'),
        'Runner disconnect',
      );
      expect(
        (
          await json(
            reconnectCapture.endpoint,
            {},
            { authorization: `Bearer ${reconnectCapture.key}` },
          )
        ).response.status,
      ).toBe(503);
      acceptControl = true;
      await until(
        async () => runnerLog.slice(logOffset).includes('(resumed 1)'),
        'Runner lease reconciliation',
      );
      const resumedToken = await getFresh(resumed.label);
      expect((await status(resumedToken)).data.context.runId).toBe(
        resumed.runId,
      );
      release(resumed.label);
      expect((await terminal(resumed.runId)).status).toBe('completed');
      observations.push(
        'A real WebSocket disconnect denied minting; reconnect reconciled the active Run and renewed credentials before the same shell resumed.',
      );

      const cancelled = await start('cancelled');
      await ready(cancelled.label);
      const cancelToken = await getFresh(cancelled.label);
      const cancelExpiry = Date.parse(
        (await status(cancelToken)).data.expiresAt,
      );
      const cancelCapture = captures.get(cancelled.label)!;
      const cancellation = await json(
        `${origin}/api/agent/runs/${cancelled.runId}/cancel`,
        {},
        { cookie, origin },
      );
      expect(cancellation.response.ok).toBe(true);
      expect((await terminal(cancelled.runId)).status).toBe('cancelled');
      expect((await status(cancelToken)).response.ok).toBe(false);
      expect(cancelExpiry).toBeGreaterThan(Date.now());
      await expect(fetch(cancelCapture.endpoint)).rejects.toThrow(
        'fetch failed',
      );
      release(cancelled.label);
      observations.push(
        'Real cancellation terminated the command/channel and immediately rejected its unexpired native JWT.',
      );

      const reassigned = await start('reassigned');
      await ready(reassigned.label);
      const assignedToken = await getFresh(reassigned.label);
      const assignedCapture = captures.get(reassigned.label)!;
      await database.db
        .update(database.schema.agentRuns)
        .set({ runnerId: 'replacement-runner' })
        .where(eq(database.schema.agentRuns.id, reassigned.runId));
      expect((await status(assignedToken)).response.ok).toBe(false);
      const denied = await json(
        assignedCapture.endpoint,
        {},
        { authorization: `Bearer ${assignedCapture.key}` },
      );
      expect(denied.response.status).toBe(503);
      // Restore only to deliver cleanup through the actual cancelling Runner path.
      await database.db
        .update(database.schema.agentRuns)
        .set({ runnerId })
        .where(eq(database.schema.agentRuns.id, reassigned.runId));
      await json(
        `${origin}/api/agent/runs/${reassigned.runId}/cancel`,
        {},
        { cookie, origin },
      );
      await terminal(reassigned.runId);
      release(reassigned.label);
      observations.push(
        'Forced reassignment rejected the old unexpired JWT and denied renewal through the real internal mint endpoint.',
      );

      const leased = await start('expired-lease');
      await ready(leased.label);
      const leaseToken = await getFresh(leased.label);
      await database.db
        .update(database.schema.agentRuns)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(database.schema.agentRuns.id, leased.runId));
      expect((await status(leaseToken)).response.ok).toBe(false);
      const lc = captures.get(leased.label)!;
      expect(
        (await json(lc.endpoint, {}, { authorization: `Bearer ${lc.key}` }))
          .response.status,
      ).toBe(503);
      await json(
        `${origin}/api/agent/runs/${leased.runId}/cancel`,
        {},
        { cookie, origin },
      );
      await terminal(leased.runId);
      release(leased.label);
      observations.push(
        'An expired live lease rejected both public authority and credential renewal.',
      );

      const rows = await database.db.query.agentSessions.findMany();
      const captured =
        JSON.stringify(rows) + modelRequests + platformLog + runnerLog;
      assert(
        !/eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(captured),
        'A JWT reached captured output.',
      );
      assert(
        !captured.includes(fleet) && !modelRequests.includes(secret),
        'A control secret reached captured output.',
      );
      for (const item of captures.values()) {
        assert(
          !captured.includes(item.token) && !captured.includes(item.key),
          'An injected credential reached logs, model context or transcripts.',
        );
      }
      const configs = (await allFiles(path.join(root, 'runner'))).filter(
        (file) => /(?:config\.json|\.env)$/.test(file),
      );
      expect(configs).toEqual([]);
      for (const file of await allFiles(path.join(root, 'runner'))) {
        const contents = await readFile(file);
        for (const item of captures.values())
          assert(
            !contents.includes(Buffer.from(item.token)) &&
              !contents.includes(Buffer.from(item.key)),
            'An injected credential was persisted.',
          );
      }
      observations.push(
        'No CLI profiles/.env were created and no captured injected JWT/channel key appeared in model requests, persisted transcripts, logs or Runner files.',
      );
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(
          path.join(evidenceDir, 'runner-cli-results.json'),
          JSON.stringify(
            {
              observations,
              limitation:
                'Local macOS Runner with enforced OS sandbox; external deployment and Linux container isolation are not proved by this suite.',
            },
            null,
            2,
          ),
        );
        await writeFile(path.join(evidenceDir, 'runner.log'), runnerLog);
        await writeFile(path.join(evidenceDir, 'platform.log'), platformLog);
      }
    }, 240000);
  },
);
