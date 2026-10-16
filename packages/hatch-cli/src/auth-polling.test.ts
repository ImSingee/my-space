import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { runAuth } from './auth';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn<typeof delay>() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('does not poll after a deadline-truncated slow_down wait wakes early', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hatch-cli-polling-'));
  const config = join(directory, 'config.json');
  let now = 0;
  let waits = 0;
  let polls = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  for (const key of ['HATCH_CLI_URL', 'HATCH_CLI_TOKEN', 'HATCH_CLI_API_KEY'])
    vi.stubEnv(key, undefined);
  vi.mocked(delay).mockImplementation(async (milliseconds = 1, value) => {
    waits++;
    now += milliseconds - (waits === 2 ? 1 : 0);
    return value;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/device/code'))
        return Response.json({
          device_code: 'fixture-device-code',
          user_code: 'ABCD1234',
          verification_uri_complete: 'http://localhost/cli/authorize',
          expires_in: 10,
          interval: 0.02,
        });
      expect(url).toBe('http://localhost/api/auth/device/token');
      polls++;
      return Response.json({ error: 'slow_down' }, { status: 400 });
    }),
  );
  try {
    await expect(
      runAuth(
        [
          'auth',
          'login',
          '--url',
          'http://localhost',
          '--no-browser',
          '--timeout',
          '0.2',
          '--config',
          config,
        ],
        0,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'login_timeout', exitCode: 7 });
    expect(polls).toBe(1);
    await expect(stat(config)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
