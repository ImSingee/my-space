/** Command/CLI credential isolation, renewal and failure boundaries. */
import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandCredentials } from './command-credentials';
import { refreshRunEnvironment } from '../../packages/hatch-cli/src/run-credential';
import { environmentCredential } from '../../packages/hatch-cli/src/config';

const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});
async function fixture() {
  let calls = 0;
  let status = 200;
  let hang = false;
  let wrongBinding = false;
  let failures = 0;
  let clockOffset = 0;
  let expired = false;
  const server = http.createServer(async (req, res) => {
    calls++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const runId = req.url!.split('/')[4];
    const { runnerId } = JSON.parse(raw);
    if (hang) return;
    const currentStatus = failures-- > 0 ? 503 : status;
    res.writeHead(currentStatus, {
      'content-type': 'application/json',
      date: new Date(Date.now() + clockOffset).toUTCString(),
    });
    res.end(
      JSON.stringify({
        token: `credential-${runId}-${calls}`,
        expiresAt: new Date(
          Date.now() + clockOffset + (expired ? -1000 : 5000),
        ).toISOString(),
        context: {
          runId: wrongBinding ? 'other-run' : runId,
          runnerId,
          sessionId: `session-${runId}`,
        },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let connected = true;
  const run = (runId: string, controller = new AbortController()) =>
    createCommandCredentials({
      platformUrl: baseUrl,
      cliUrl: 'http://platform:3700',
      fleetToken: 'fleet-private',
      runnerId: 'runner-1',
      runId,
      sessionId: `session-${runId}`,
      signal: controller.signal,
      isConnected: () => connected,
    });
  return {
    run,
    get calls() {
      return calls;
    },
    failures: (value: number) => {
      failures = value;
    },
    skew: (value: number) => {
      clockOffset = value;
    },
    expire: () => {
      expired = true;
    },
    status: (value: number) => {
      status = value;
    },
    hang: () => {
      hang = true;
    },
    wrongBinding: () => {
      wrongBinding = true;
    },
    disconnect: () => {
      connected = false;
    },
  };
}

describe('Run command credentials', () => {
  it('renews for CLI starts inside a captured shell, isolates runs, and closes the channel', async () => {
    const f = await fixture();
    const first = f.run('one');
    let endpoint = '';
    await Promise.all(
      ['one', 'two'].map(async (id) => {
        const provider = id === 'one' ? first : f.run(id);
        await provider.withEnvironment(undefined, async (credential) => {
          endpoint = credential.env.HATCH_CLI_RUN_ENDPOINT;
          const original = credential.env.HATCH_CLI_TOKEN;
          const child = { ...credential.env };
          await refreshRunEnvironment(child, credential.signal);
          expect(child.HATCH_CLI_TOKEN).not.toBe(original);
          expect(child.HATCH_CLI_TOKEN).toContain(`credential-${id}-`);
          expect(environmentCredential(child)).toMatchObject({
            url: 'http://platform:3700',
            token: child.HATCH_CLI_TOKEN,
          });
          // A shell retains the original environment; the next process still renews.
          const later = { ...credential.env };
          await refreshRunEnvironment(later, credential.signal);
          expect(later.HATCH_CLI_TOKEN).not.toBe(child.HATCH_CLI_TOKEN);
          const denied = await fetch(endpoint, {
            method: 'POST',
            headers: { authorization: 'Bearer another-run' },
          });
          expect(denied.status).toBe(403);
          expect(Object.values(credential.env)).not.toContain('fleet-private');
        });
      }),
    );
    await expect(fetch(endpoint)).rejects.toThrow('fetch failed');
    // An entirely new command also receives a new credential.
    await first.withEnvironment(undefined, async (credential) => {
      expect(credential.env.HATCH_CLI_TOKEN).toContain('credential-one-');
    });
  });

  it('redacts issued credentials and local channel keys across output chunks', async () => {
    const f = await fixture();
    await f.run('one').withEnvironment(undefined, async (credential) => {
      const child = { ...credential.env };
      await refreshRunEnvironment(child, credential.signal);
      const raw = `${credential.env.HATCH_CLI_TOKEN}\n${child.HATCH_CLI_TOKEN}\n${credential.env.HATCH_CLI_RUN_SECRET}\n`;
      let output = '';
      const stream = credential.stream((value) => {
        output += value;
      });
      for (const character of raw) stream.write(character);
      stream.flush();
      expect(output).toBe('[redacted]\n[redacted]\n[redacted]\n');
      expect(credential.redact(raw)).toBe(output);
    });
  });

  it('fails closed on rejected binding without launching a command or echoing responses', async () => {
    const f = await fixture();
    f.status(403);
    let launched = false;
    await expect(
      f.run('one').withEnvironment(undefined, async () => {
        launched = true;
      }),
    ).rejects.toThrow('Run CLI credentials are unavailable.');
    expect(launched).toBe(false);
    expect(f.calls).toBe(1);
    f.status(200);
    f.wrongBinding();
    await expect(
      f.run('one').withEnvironment(undefined, async () => {}),
    ).rejects.toThrow('Run CLI credentials are unavailable.');
    expect(f.calls).toBe(2);
  });

  it('bounds transient mint retries and never falls back to expired credentials or profiles', async () => {
    const f = await fixture();
    await f.run('one').withEnvironment(undefined, async (credential) => {
      f.status(503);
      const child = { ...credential.env };
      await expect(
        refreshRunEnvironment(child, credential.signal),
      ).rejects.toMatchObject({ code: 'run_credentials_unavailable' });
      expect(f.calls).toBe(4);
      expect(child.HATCH_CLI_TOKEN).toBe(credential.env.HATCH_CLI_TOKEN);
    });
  });

  it('recovers from bounded transient mint failures without replaying the command', async () => {
    const f = await fixture();
    f.failures(2);
    let executions = 0;
    await f.run('one').withEnvironment(undefined, async () => {
      executions++;
    });
    expect(f.calls).toBe(3);
    expect(executions).toBe(1);
  });

  it('uses the server clock and rejects credentials without the expiry margin', async () => {
    const f = await fixture();
    f.skew(86400000);
    await f.run('one').withEnvironment(undefined, async () => {});
    f.expire();
    await expect(
      f.run('one').withEnvironment(undefined, async () => {}),
    ).rejects.toThrow('Run CLI credentials are unavailable.');
    expect(f.calls).toBe(2);
  });

  it('cancels pending renewal and closes its broker immediately', async () => {
    const f = await fixture();
    const controller = new AbortController();
    await f
      .run('one', controller)
      .withEnvironment(undefined, async (credential) => {
        f.hang();
        const renewal = refreshRunEnvironment(
          { ...credential.env },
          new AbortController().signal,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        controller.abort();
        await expect(renewal).rejects.toMatchObject({
          code: 'run_credentials_unavailable',
        });
        expect(credential.signal.aborted).toBe(true);
        expect(f.calls).toBe(2);
        await expect(
          fetch(credential.env.HATCH_CLI_RUN_ENDPOINT),
        ).rejects.toThrow('fetch failed');
      });
  });

  it('denies renewal while disconnected and resumes only through fresh binding checks', async () => {
    const f = await fixture();
    await f.run('one').withEnvironment(undefined, async (credential) => {
      f.disconnect();
      await expect(
        refreshRunEnvironment({ ...credential.env }, credential.signal),
      ).rejects.toMatchObject({ code: 'run_credentials_unavailable' });
      expect(f.calls).toBe(1);
    });
  });

  it('preserves local environment/config behavior and rejects remote credential brokers', async () => {
    const env = {
      HATCH_CLI_URL: 'https://platform.test',
      HATCH_CLI_TOKEN: 'local-session',
    };
    await refreshRunEnvironment(env, new AbortController().signal);
    expect(environmentCredential(env)).toEqual({
      url: env.HATCH_CLI_URL,
      token: env.HATCH_CLI_TOKEN,
    });
    expect(() =>
      environmentCredential({ ...env, HATCH_CLI_URL: 'http://platform:3700' }),
    ).toThrow('HTTPS');
    await expect(
      refreshRunEnvironment(
        {
          ...env,
          HATCH_CLI_RUN_ENDPOINT: 'https://remote.test/credential',
          HATCH_CLI_RUN_SECRET: 'a'.repeat(64),
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'run_credentials_unavailable' });
  });
});
