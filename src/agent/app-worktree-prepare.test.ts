import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const run = promisify(execFile);
const originalDataDir = process.env.HATCH_DATA_DIR;
const testDataRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'hatch-prepare-data-'),
);
await fs.chmod(testDataRoot, 0o755);
process.env.HATCH_DATA_DIR = testDataRoot;
const [{ materializeAppHatchSdk }, { prepareAppWorktree }, shellEnvModule] =
  await Promise.all([
    import('./hatch-sdk'),
    import('./app-worktree-prepare'),
    import('./shell-env'),
  ]);
const { agentShellEnv, PLATFORM_NODE_BIN_DIR } = shellEnvModule;

async function defaultAppRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-prepare-app-'));
  tempDirs.push(root);
  await fs.cp(new URL('../../templates/default-app/', import.meta.url), root, {
    recursive: true,
  });
  const manifestPath = path.join(root, 'manifest.json');
  const packagePath = path.join(root, 'package.json');
  await Promise.all([
    fs.writeFile(
      manifestPath,
      (await fs.readFile(manifestPath, 'utf8'))
        .replaceAll('__APP_ID__', 'prepared-app')
        .replaceAll('__APP_NAME__', 'Prepared App')
        .replaceAll('__APP_DESCRIPTION__', 'Prepared by test'),
    ),
    fs.writeFile(
      packagePath,
      (await fs.readFile(packagePath, 'utf8')).replaceAll(
        '__APP_ID__',
        'prepared-app',
      ),
    ),
  ]);
  await materializeAppHatchSdk(root);
  // Linux CI demotes preparation commands to hatch-sandbox.
  await fs.chmod(root, 0o777);
  return root;
}

async function minimalAppRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-prepare-app-'));
  tempDirs.push(root);
  await Promise.all([
    fs.writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ id: 'prepared-app' }),
      'utf8',
    ),
    fs.writeFile(
      path.join(root, 'package.json'),
      '{"type":"module"}\n',
      'utf8',
    ),
    fs.writeFile(
      path.join(root, 'deno.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          jsx: 'react-jsx',
          jsxImportSource: 'react',
        },
        allowScripts: [],
      }),
      'utf8',
    ),
    fs.writeFile(
      path.join(root, 'deno.lock'),
      JSON.stringify({ version: '5', npm: {} }),
      'utf8',
    ),
  ]);
  await materializeAppHatchSdk(root);
  await fs.chmod(root, 0o777);
  return root;
}

async function minimalAgentAppRoot(): Promise<string> {
  const sessionId = `prepare-agent-${randomUUID()}`;
  const { agentSessionDir, agentWorkDir } = await import('./paths');
  const { prepareAgentSessionSandbox, setAgentOwned } =
    await import('./shell-sandbox');
  prepareAgentSessionSandbox(sessionId);
  const root = await fs.mkdtemp(
    path.join(agentWorkDir(sessionId), 'prepare-app-'),
  );
  tempDirs.push(agentSessionDir(sessionId));
  await Promise.all([
    fs.writeFile(path.join(root, 'manifest.json'), '{"id":"app"}\n'),
    fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n'),
    fs.writeFile(
      path.join(root, 'deno.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          jsx: 'react-jsx',
          jsxImportSource: 'react',
        },
        allowScripts: [],
      }),
    ),
    fs.writeFile(path.join(root, 'deno.lock'), '{"version":"5","npm":{}}\n'),
  ]);
  setAgentOwned([root], sessionId);
  await materializeAppHatchSdk(root);
  return root;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(target: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await exists(target))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${target}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Descendant process ${pid} survived preparation.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function fakeTrustedDeno(body: string): Promise<string> {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-fake-bin-'));
  tempDirs.push(bin);
  const executable = path.join(bin, 'deno');
  await fs.writeFile(executable, `#!${process.execPath}\n${body}\n`, 'utf8');
  await Promise.all([fs.chmod(bin, 0o755), fs.chmod(executable, 0o755)]);
  return bin;
}

async function withPrepPath<T>(
  bin: string,
  operation: () => Promise<T>,
): Promise<T> {
  const originalPath = process.env.PATH;
  process.env.PATH = [bin, originalPath]
    .filter((entry): entry is string => Boolean(entry))
    .join(path.delimiter);
  try {
    return await operation();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  if (originalDataDir === undefined) delete process.env.HATCH_DATA_DIR;
  else process.env.HATCH_DATA_DIR = originalDataDir;
  await fs.rm(testDataRoot, { recursive: true, force: true });
});

describe('prepareAppWorktree', () => {
  it('prepares a cold scaffold without trusting App-local executables', async () => {
    const root = await defaultAppRoot();
    const appBin = path.join(root, 'node_modules', '.bin');
    const denoMarker = path.join(root, 'hijacked-deno');
    const pluginMarker = path.join(root, 'hijacked-protoc-gen-es');
    await fs.mkdir(appBin, { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(appBin, 'deno'),
        `#!/bin/sh\nprintf hijacked > ${JSON.stringify(denoMarker)}\n`,
      ),
      fs.writeFile(
        path.join(appBin, 'protoc-gen-es'),
        `#!/bin/sh\nprintf hijacked > ${JSON.stringify(pluginMarker)}\n`,
      ),
    ]);
    await Promise.all([
      fs.chmod(path.join(appBin, 'deno'), 0o755),
      fs.chmod(path.join(appBin, 'protoc-gen-es'), 0o755),
    ]);

    const shellEnv = agentShellEnv();
    expect((shellEnv.PATH ?? '').split(path.delimiter)[0]).toBe(
      PLATFORM_NODE_BIN_DIR,
    );
    expect((shellEnv.PATH ?? '').split(path.delimiter)).not.toContain(appBin);
    await run('buf', ['generate', '--template', '.hatch/buf.gen.yaml'], {
      cwd: root,
      env: { ...process.env, ...shellEnv },
    });
    await expect(fs.access(pluginMarker)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const authoredFiles = [
      'manifest.json',
      'package.json',
      'deno.json',
      'deno.lock',
      'buf.yaml',
      'buf.gen.yaml',
    ];
    const before = await Promise.all(
      authoredFiles.map((file) => fs.readFile(path.join(root, file), 'utf8')),
    );
    const aliasParent = await fs.mkdtemp(
      path.join(os.tmpdir(), 'hatch-app-bin-alias-'),
    );
    tempDirs.push(aliasParent);
    const appBinAlias = path.join(aliasParent, 'bin');
    await fs.symlink(appBin, appBinAlias, 'dir');
    await Promise.all([
      fs.rm(denoMarker, { force: true }),
      fs.rm(pluginMarker, { force: true }),
    ]);

    await withPrepPath(appBinAlias, () => prepareAppWorktree(root));

    await expect(fs.access(denoMarker)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(pluginMarker)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.access(path.join(root, 'node_modules', 'react')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(root, 'gen', 'service_pb.ts')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(root, '.hatch', 'import-map.json')),
    ).resolves.toBeUndefined();
    await expect(
      Promise.all(
        authoredFiles.map((file) => fs.readFile(path.join(root, file), 'utf8')),
      ),
    ).resolves.toEqual(before);

    await run(
      'deno',
      [
        'check',
        '--config=deno.json',
        '--no-remote',
        '--node-modules-dir=auto',
        '--import-map=.hatch/import-map.json',
        '--lock=deno.lock',
        '--frozen',
        'app/main.tsx',
        'backend/main.ts',
        'widgets/counter.tsx',
        'data/schema.ts',
      ],
      { cwd: root, env: { ...process.env, ...agentShellEnv() } },
    );
  }, 120_000);

  it.each(['node_modules', 'gen', '.hatch'])(
    'rejects a symlinked generated %s root before it can write outside the App',
    async (generatedRoot) => {
      const root = await minimalAppRoot();
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), 'hatch-prepare-outside-'),
      );
      tempDirs.push(outside);
      const marker = path.join(outside, 'marker');
      await fs.writeFile(marker, 'unchanged', 'utf8');
      const target = path.join(root, generatedRoot);
      await fs.rm(target, { recursive: true, force: true });
      await fs.symlink(outside, target, 'dir');

      await expect(prepareAppWorktree(root)).rejects.toThrow(
        `${generatedRoot} must be a real directory`,
      );
      await expect(fs.readFile(marker, 'utf8')).resolves.toBe('unchanged');
      await expect(fs.readdir(outside)).resolves.toEqual(['marker']);
    },
  );

  it('runs authored source preflight with Agent traversal authority', async () => {
    const root = await minimalAgentAppRoot();
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), 'hatch-preflight-outside-'),
    );
    tempDirs.push(outside);
    await fs.symlink(outside, path.join(root, 'authored-link'), 'dir');

    await expect(prepareAppWorktree(root)).rejects.toThrow(
      'source must not contain symbolic links: authored-link',
    );
  });

  it.each([
    ['regular', minimalAppRoot],
    ['Agent', minimalAgentAppRoot],
  ] as const)(
    'rejects a non-canonical top-level .hatch case variant in a %s worktree',
    async (_kind, makeRoot) => {
      const root = await makeRoot();
      await fs.rename(path.join(root, '.hatch'), path.join(root, '.HATCH'));

      await expect(prepareAppWorktree(root)).rejects.toThrow(
        /case variant.*reserved \.hatch path.*\.HATCH/i,
      );
      await expect(fs.readdir(root)).resolves.toContain('.HATCH');
    },
  );

  it.each([
    ['DENO.JSONC', 'regular', minimalAppRoot],
    ['TSCONFIG.JSON', 'Agent', minimalAgentAppRoot],
  ] as const)(
    'rejects unsupported root configuration %s in a %s worktree',
    async (configName, _kind, makeRoot) => {
      const root = await makeRoot();
      await fs.writeFile(path.join(root, configName), '{}\n');

      await expect(prepareAppWorktree(root)).rejects.toThrow(
        `unsupported App config: ${configName}`,
      );
    },
  );

  it.each([
    ['regular', minimalAppRoot],
    ['Agent', minimalAgentAppRoot],
  ] as const)(
    'rejects a nested .hatch case variant in a %s worktree',
    async (_kind, makeRoot) => {
      const root = await makeRoot();
      const reserved = path.join(root, 'backend', '.HaTcH');
      await fs.mkdir(reserved, { recursive: true });
      await fs.writeFile(path.join(reserved, 'payload.ts'), 'export {};\n');

      await expect(prepareAppWorktree(root)).rejects.toThrow(
        /reserved \.hatch path.*backend\/\.HaTcH/i,
      );
    },
  );

  it.each([
    ['regular', minimalAppRoot],
    ['Agent', minimalAgentAppRoot],
  ] as const)(
    'rejects a case-variant root npm registry config in a %s worktree',
    async (_kind, makeRoot) => {
      const root = await makeRoot();
      await fs.writeFile(path.join(root, '.NPMRC'), 'registry=untrusted\n');

      await expect(prepareAppWorktree(root)).rejects.toThrow(
        /platform-managed npm registry config: \.NPMRC/,
      );
    },
  );

  it.each(['node_modules', '.hatch'])(
    'rejects a non-directory generated %s root',
    async (generatedRoot) => {
      const root = await minimalAppRoot();
      const target = path.join(root, generatedRoot);
      await fs.rm(target, { recursive: true, force: true });
      await fs.writeFile(target, 'not a directory', 'utf8');

      await expect(prepareAppWorktree(root)).rejects.toThrow(
        `${generatedRoot} must be a real directory`,
      );
    },
  );

  it.each([
    ['broad', ['npm:pkg@latest']],
    ['unlocked', ['npm:pkg@1.2.3']],
  ])(
    'rejects %s allowScripts before invoking Deno',
    async (_kind, allowScripts) => {
      const root = await minimalAppRoot();
      const marker = path.join(root, 'deno-executed');
      const bin = await fakeTrustedDeno(
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`,
      );
      const configPath = path.join(root, 'deno.json');
      const config = JSON.parse(
        await fs.readFile(configPath, 'utf8'),
      ) as Record<string, unknown>;
      config.allowScripts = allowScripts;
      await fs.writeFile(configPath, JSON.stringify(config), 'utf8');

      await withPrepPath(bin, async () => {
        await expect(prepareAppWorktree(root)).rejects.toThrow(
          /allowScripts must be absent or an empty array/,
        );
      });
      await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('rejects exact lifecycle approvals before automatic install', async () => {
    const root = await minimalAppRoot();
    const argvMarker = path.join(root, 'deno-argv.json');
    const bin = await fakeTrustedDeno(
      `require('node:fs').writeFileSync(${JSON.stringify(argvMarker)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const configPath = path.join(root, 'deno.json');
    const lockPath = path.join(root, 'deno.lock');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
      npm: Record<string, unknown>;
    };
    config.allowScripts = ['npm:test-lifecycle@1.2.3'];
    lock.npm['test-lifecycle@1.2.3'] = {};
    await Promise.all([
      fs.writeFile(configPath, JSON.stringify(config), 'utf8'),
      fs.writeFile(lockPath, JSON.stringify(lock), 'utf8'),
    ]);
    await expect(
      withPrepPath(bin, () => prepareAppWorktree(root)),
    ).rejects.toThrow(/allowScripts must be absent or an empty array/);
    await expect(fs.access(argvMarker)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['abort', 'timeout'] as const)(
    '%s terminates descendants instead of leaving preparation work running',
    async (mode) => {
      const root = await minimalAppRoot();
      const started = path.join(root, `${mode}-descendant-started`);
      const descendantMarker = path.join(root, `${mode}-descendant-finished`);
      const markerDelayMs = mode === 'timeout' ? 4500 : 1000;
      const descendant = [
        "const fs = require('node:fs');",
        `setTimeout(() => fs.writeFileSync(${JSON.stringify(descendantMarker)}, 'escaped'), ${markerDelayMs});`,
        'setInterval(() => {}, 1000);',
      ].join(' ');
      const bin = await fakeTrustedDeno(
        [
          "const fs = require('node:fs');",
          "const { spawn } = require('node:child_process');",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });`,
          `fs.writeFileSync(${JSON.stringify(started)}, String(child.pid));`,
          'setInterval(() => {}, 1000);',
        ].join('\n'),
      );

      await withPrepPath(bin, async () => {
        const controller = new AbortController();
        const pending = prepareAppWorktree(
          root,
          controller.signal,
          mode === 'timeout' ? { timeoutMs: 4000 } : { timeoutMs: 5000 },
        );
        const outcome = pending.then(
          () => null,
          (error: unknown) => error,
        );
        await waitForFile(started);
        const descendantPid = Number(await fs.readFile(started, 'utf8'));
        if (mode === 'abort') controller.abort();
        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
          mode === 'timeout' ? /timed out/ : /operation was aborted/,
        );
        await waitForProcessExit(descendantPid);
      });

      await new Promise((resolve) => setTimeout(resolve, 1200));
      await expect(fs.access(descendantMarker)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
    10_000,
  );

  it('terminates a descendant when its successful parent exits first', async () => {
    const root = await minimalAppRoot();
    const descendantMarker = path.join(root, 'successful-descendant-finished');
    const descendant = [
      "const fs = require('node:fs');",
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(descendantMarker)}, 'escaped'), 1000);`,
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const bin = await fakeTrustedDeno(
      [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });`,
        'child.unref();',
      ].join('\n'),
    );

    await withPrepPath(bin, () => prepareAppWorktree(root));
    await new Promise((resolve) => setTimeout(resolve, 1200));

    await expect(fs.access(descendantMarker)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
