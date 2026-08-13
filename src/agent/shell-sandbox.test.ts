import { execFile, spawn } from 'node:child_process';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'hatch-session-sandbox-'));
process.env.HATCH_DATA_DIR = root;

const {
  BUILD_WORK_DIR,
  AGENT_HOME_DIR,
  AGENT_IDENTITIES_PATH,
  AGENT_LEGACY_HOME_DIR,
  AGENTS_DIR,
  agentHomeDir,
  agentSessionDir,
  agentWorkDir,
} = await import('./paths');
const {
  enforceAgentSandboxPolicy,
  prepareAgentSessionSandbox,
  resolveAgentOwnershipSession,
  sandboxFileSpawn,
  secureLegacyAgentHomes,
  setAgentOwned,
  wrapShellCommand,
} = await import('./shell-sandbox');

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function runFor(sessionId: string, command: string) {
  return run('/bin/sh', ['-c', wrapShellCommand(command, sessionId)], {
    cwd: agentWorkDir(sessionId),
  });
}

describe('per-session Agent sandbox', () => {
  it('keeps Platform paths owned by the Platform and resolves Agent paths', () => {
    const session = 'ownership-session';
    const other = 'ownership-other';
    const platformTargets = [
      path.join(BUILD_WORK_DIR, 'app', 'node_modules', '@hatch', 'data.tmp'),
      path.join(BUILD_WORK_DIR, 'app', 'node_modules', '@hatch', 'map.tmp'),
    ];
    expect(resolveAgentOwnershipSession(platformTargets)).toBeUndefined();
    expect(
      resolveAgentOwnershipSession([
        path.join(agentWorkDir(session), 'sdk.tmp'),
        path.join(agentWorkDir(session), 'import-map.tmp'),
      ]),
    ).toBe(session);
    expect(
      resolveAgentOwnershipSession(
        [path.join(root, 'explicit-session-temp')],
        session,
      ),
    ).toBe(session);
    expect(() =>
      resolveAgentOwnershipSession([
        path.join(agentWorkDir(session), 'sdk.tmp'),
        path.join(agentWorkDir(other), 'sdk.tmp'),
      ]),
    ).toThrow(/one Agent session/);
    expect(() =>
      resolveAgentOwnershipSession([
        path.join(agentWorkDir(session), 'sdk.tmp'),
        platformTargets[0],
      ]),
    ).toThrow(/one Agent session/);
    expect(() =>
      resolveAgentOwnershipSession(
        [path.join(agentWorkDir(other), 'sdk.tmp')],
        session,
      ),
    ).toThrow(/another Agent session/);
    expect(() => resolveAgentOwnershipSession([AGENTS_DIR])).toThrow(
      /namespace root/,
    );
  });

  it('quarantines legacy shared-HOME entries but preserves session homes', async () => {
    await mkdir(path.join(AGENTS_DIR, 'existing-session', 'work'), {
      recursive: true,
    });
    await mkdir(path.join(AGENT_HOME_DIR, 'existing-session'), {
      recursive: true,
    });
    await mkdir(path.join(AGENT_HOME_DIR, '.config'), { recursive: true });
    await writeFile(path.join(AGENT_HOME_DIR, '.config', 'credential'), 'old');
    await writeFile(path.join(AGENT_HOME_DIR, '.npmrc'), 'old');

    secureLegacyAgentHomes();

    await expect(
      access(agentHomeDir('existing-session')),
    ).resolves.toBeUndefined();
    await expect(access(path.join(AGENT_HOME_DIR, '.config'))).rejects.toThrow(
      /ENOENT|no such file/,
    );
    await expect(access(path.join(AGENT_HOME_DIR, '.npmrc'))).rejects.toThrow(
      /ENOENT|no such file/,
    );
    expect(await readdir(AGENT_LEGACY_HOME_DIR)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\.config\./),
        expect.stringMatching(/^\.npmrc\./),
      ]),
    );
    expect((await lstat(AGENT_LEGACY_HOME_DIR)).mode & 0o777).toBe(0o700);
  });

  it('refuses an unavailable macOS sandbox in production unless overridden', () => {
    expect(() =>
      enforceAgentSandboxPolicy({
        available: false,
        platform: 'darwin',
        production: true,
        allowUnsandboxed: false,
      }),
    ).toThrow(/Refusing to start in production/);
    expect(() =>
      enforceAgentSandboxPolicy({
        available: false,
        platform: 'darwin',
        production: true,
        allowUnsandboxed: true,
      }),
    ).not.toThrow();
    expect(() =>
      enforceAgentSandboxPolicy({
        available: false,
        platform: 'win32',
        production: true,
        allowUnsandboxed: false,
      }),
    ).toThrow(/unsupported on win32/);
  });

  it('keeps the fixed helper available in an unsandboxed dev fallback', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    )!;
    const previousAppUrl = process.env.APP_URL;
    const previousNodeEnv = process.env.NODE_ENV;
    try {
      Object.defineProperty(process, 'platform', {
        ...platformDescriptor,
        value: 'win32',
      });
      process.env.APP_URL = 'http://127.0.0.1:3000';
      process.env.NODE_ENV = 'test';
      expect(
        sandboxFileSpawn(
          ['/fixed/file-helper', '--one'],
          'unsandboxed-dev-fallback',
        ),
      ).toEqual({ command: '/fixed/file-helper', args: ['--one'] });
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
      if (previousAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = previousAppUrl;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('rejects control characters in session ids', () => {
    expect(() => agentSessionDir('safe\n(allow default)')).toThrow(
      /Invalid Agent session id/,
    );
    expect(() => agentHomeDir('safe\u007funsafe')).toThrow(
      /Invalid Agent session id/,
    );
    expect(() => agentSessionDir('safe\ud800unsafe')).toThrow(
      /Invalid Agent session id/,
    );
  });

  it('allows own work but denies another session and the work root entry', async () => {
    const first = 'sandbox-first';
    const second = 'sandbox-second';
    prepareAgentSessionSandbox(first);
    prepareAgentSessionSandbox(second);
    await writeFile(path.join(agentWorkDir(first), 'own.txt'), 'own');
    await writeFile(path.join(agentHomeDir(first), 'home.txt'), 'home');
    await writeFile(path.join(agentWorkDir(second), 'other.txt'), 'other');

    const wrapped = wrapShellCommand('true', first);
    if (wrapped === 'true') return;

    await expect(runFor(first, 'cat own.txt')).resolves.toMatchObject({
      stdout: 'own',
    });
    await expect(
      runFor(first, `cat '${path.join(agentHomeDir(first), 'home.txt')}'`),
    ).resolves.toMatchObject({ stdout: 'home' });
    await expect(
      runFor(first, 'cat ../../sandbox-second/work/other.txt'),
    ).rejects.toThrow(/Command failed/);
    await expect(runFor(first, 'mv ../work ../moved')).rejects.toThrow(
      /Command failed/,
    );
  });

  it.runIf(process.platform === 'darwin')(
    'denies platform credential paths from the session shell',
    async () => {
      const sessionId = 'sandbox-platform-credential';
      prepareAgentSessionSandbox(sessionId);
      const credential = path.join(
        process.cwd(),
        `.env.shell-sandbox-${process.pid}`,
      );
      await writeFile(credential, 'credential-canary');
      try {
        await expect(runFor(sessionId, `cat '${credential}'`)).rejects.toThrow(
          /Command failed/,
        );
      } finally {
        await rm(credential, { force: true });
      }
    },
  );

  it.runIf(process.platform === 'linux' && process.getuid?.() === 0)(
    'persists distinct numeric identities in root-owned metadata',
    async () => {
      const first = prepareAgentSessionSandbox('numeric-first');
      const repeated = prepareAgentSessionSandbox('numeric-first');
      const second = prepareAgentSessionSandbox('numeric-second');
      if (!first || !second) return;

      expect(repeated).toEqual(first);
      expect(second.uid).not.toBe(first.uid);
      expect(first.uid).toBe(first.gid);

      const mapping = await lstat(AGENT_IDENTITIES_PATH);
      expect(mapping.uid).toBe(0);
      expect(mapping.gid).toBe(0);
      expect(mapping.mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(AGENT_IDENTITIES_PATH, 'utf8'))).toEqual(
        expect.objectContaining({
          sessions: expect.objectContaining({
            'numeric-first': first,
            'numeric-second': second,
          }),
        }),
      );

      for (const directory of [AGENTS_DIR, AGENT_HOME_DIR]) {
        const info = await lstat(directory);
        expect(info.uid).toBe(0);
        expect(info.mode & 0o022).toBe(0);
      }
      const session = await lstat(agentSessionDir('numeric-first'));
      expect(session.uid).toBe(0);
      expect(session.gid).toBe(first.gid);
      expect(session.mode & 0o022).toBe(0);
      expect(session.mode & 0o777).toBe(0o710);
      for (const directory of [
        agentWorkDir('numeric-first'),
        agentHomeDir('numeric-first'),
      ]) {
        const info = await lstat(directory);
        expect(info.uid).toBe(first.uid);
        expect(info.gid).toBe(first.gid);
        expect(info.mode & 0o777).toBe(0o700);
      }

      const generated = path.join(
        agentWorkDir('numeric-first'),
        'root-generated.txt',
      );
      await writeFile(generated, 'generated');
      setAgentOwned([generated]);
      const generatedInfo = await lstat(generated);
      expect(generatedInfo.uid).toBe(first.uid);
      expect(generatedInfo.gid).toBe(first.gid);

      const platformBuild = path.join(BUILD_WORK_DIR, 'root-generated.txt');
      await mkdir(BUILD_WORK_DIR, { recursive: true });
      await writeFile(platformBuild, 'platform');
      setAgentOwned([platformBuild]);
      const platformInfo = await lstat(platformBuild);
      expect(platformInfo.uid).toBe(0);
      expect(platformInfo.gid).toBe(0);

      await writeFile(
        path.join(agentSessionDir('numeric-first'), 'runner-metadata.json'),
        'own metadata',
      );
      await writeFile(
        path.join(agentSessionDir('numeric-second'), 'runner-metadata.json'),
        'other metadata',
      );
      await expect(
        runFor('numeric-first', 'cat ../runner-metadata.json'),
      ).resolves.toMatchObject({ stdout: 'own metadata' });
      await expect(
        runFor(
          'numeric-first',
          'cat ../../numeric-second/runner-metadata.json',
        ),
      ).rejects.toThrow(/Command failed/);
    },
  );

  it.runIf(process.platform === 'linux' && process.getuid?.() === 0)(
    'serializes identity allocation across Runner processes',
    async () => {
      const probe = prepareAgentSessionSandbox('multiprocess-probe');
      if (!probe) return;
      const sourcePath = new URL('./shell-sandbox.ts', import.meta.url)
        .pathname;
      const bundlePath = path.join(root, 'shell-sandbox-test.mjs');
      await run(
        path.resolve('node_modules/.bin/esbuild'),
        [
          sourcePath,
          '--bundle',
          '--platform=node',
          '--format=esm',
          `--outfile=${bundlePath}`,
        ],
        { env: process.env },
      );
      const moduleUrl = new URL(`file://${bundlePath}`).href;
      const script = `
        const { prepareAgentSessionSandbox } = await import(process.argv[1]);
        const identity = prepareAgentSessionSandbox(process.argv[2]);
        process.stdout.write(JSON.stringify(identity));
      `;
      const children = Array.from({ length: 8 }, (_, index) =>
        spawn(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            script,
            moduleUrl,
            `multiprocess-${index}`,
          ],
          {
            env: { ...process.env, HATCH_DATA_DIR: root },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      );
      const outputs = await Promise.all(
        children.map(
          (child) =>
            new Promise<string>((resolve, reject) => {
              let stdout = '';
              let stderr = '';
              child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
              });
              child.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
              });
              child.on('error', reject);
              child.on('close', (code) => {
                if (code === 0) resolve(stdout);
                else reject(new Error(stderr || `child exited ${code}`));
              });
            }),
        ),
      );
      const identities = outputs.map(
        (output) => JSON.parse(output) as { uid: number; gid: number },
      );
      expect(new Set(identities.map(({ uid }) => uid)).size).toBe(8);

      const mapping = JSON.parse(
        await readFile(AGENT_IDENTITIES_PATH, 'utf8'),
      ) as { sessions: Record<string, { uid: number; gid: number }> };
      for (const [index, identity] of identities.entries()) {
        expect(mapping.sessions[`multiprocess-${index}`]).toEqual(identity);
      }
    },
  );
});
