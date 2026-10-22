import { connectNodeAdapter } from '@connectrpc/connect-node';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  AppService,
  type CreateAppRequest,
} from '../../hatch-platform-api/gen/hatch/platform/v1/app_pb';
import { WorkflowService } from '../../hatch-platform-api/gen/hatch/platform/v1/workflow_pb';
import { SdkService } from '../../hatch-platform-api/gen/hatch/platform/v1/sdk_pb';
import { fromJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
/** Durable CLI source/data boundaries through real child processes and Git. */
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
let directory: string;
let origin: string;
let generation: string;
let bundle: string | null;
let master: string | null;
let deploys: number;
let loseResponse: boolean;
let sdkDelay: (() => Promise<void>) | undefined;
let sdkFailure: boolean;
let resourceSlug: string;
let createRequests: unknown[];
const token = 'private-workspace-test-secret';
const getResource = (kind: 'app' | 'workflow') => ({
  id: 'immutable',
  slug: resourceSlug,
  name: 'Fixture',
  status: 'draft',
  createdAt: generation,
  updatedAt: generation,
  view: fromJson(ValueSchema, {
    id: 'immutable',
    slug: resourceSlug,
    name: 'Fixture',
    description: null,
    status: 'draft',
    createdAt: generation,
    updatedAt: generation,
    compatibility: null,
    deployments: [],
    ...(kind === 'workflow'
      ? {
          liveVersion: null,
          inputSchema: {},
          network: null,
          webhook: { enabled: false, url: null },
          cron: [],
          recentRuns: [],
        }
      : {
          currentVersion: null,
          capabilities: [],
          backendMode: null,
          dbName: null,
          dataDbName: null,
          currentDeploymentId: null,
          currentSourceCommit: null,
          manifest: null,
          ops: {
            backend: {
              capable: false,
              mode: null,
              running: false,
              network: null,
            },
            cron: { enabled: false, jobs: [] },
            webhook: {
              enabled: false,
              url: null,
              hasSecret: false,
              auth: 'platform',
            },
            storage: { enabled: false },
            kv: { enabled: false, url: null, entryCount: 0 },
            dataTable: {
              enabled: false,
              url: null,
              dbName: null,
              schemaHash: null,
            },
          },
        }),
  }),
});
function createResource(
  data: Pick<CreateAppRequest, 'slug' | 'name' | 'pin' | 'description'>,
) {
  createRequests.push({
    slug: data.slug,
    name: data.name,
    ...(data.pin === undefined ? {} : { pin: data.pin }),
    ...(data.description === undefined
      ? {}
      : { description: data.description }),
  });
  resourceSlug = data.slug;
  return {
    id: 'immutable',
    slug: resourceSlug,
    name: 'Fixture',
    files: [
      {
        path: 'package.json',
        content: Buffer.from('{"type":"module","dependencies":{}}'),
      },
      {
        path: 'manifest.ts',
        content: Buffer.from(
          'export default {id:"immutable", compatibilityVersion:1};',
        ),
      },
    ],
  };
}
const rpc = connectNodeAdapter({
  requestPathPrefix: '/api/rpc',
  requestGate: (context) => {
    if (context.requestHeader.get('authorization') !== `Bearer ${token}`)
      throw new ConnectError('Unauthorized', Code.Unauthenticated);
  },
  routes: (router) => {
    router.service(AppService, {
      createApp: createResource,
      getApp: () => ({ resource: getResource('app') }),
      associateAppSession: () => ({
        appId: 'immutable',
        association: 'not-applicable',
      }),
    });
    router.service(WorkflowService, {
      createWorkflow: createResource,
      getWorkflow: () => ({ resource: getResource('workflow') }),
      getWorkflowSource: () => ({
        source: {
          id: 'immutable',
          masterCommit: master ?? undefined,
          bundle: bundle === null ? undefined : Buffer.from(bundle, 'base64'),
        },
      }),
      deployWorkflow: async (data) => {
        deploys++;
        const file = join(directory, 'uploaded.bundle');
        await writeFile(file, data.bundle);
        const refs = execFileSync('git', ['bundle', 'list-heads', file], {
          encoding: 'utf8',
        });
        master = refs.trim().split(' ')[0];
        return {
          deployment: {
            deploymentId: 'release-1',
            version: 1,
            compatibilityVersion: 1,
            normalized: fromJson(ValueSchema, {
              id: 'immutable',
              name: 'Fixture',
              description: '',
              entry: 'workflow.ts',
              triggers: { cron: [], webhook: { enabled: false, url: null } },
            }),
          },
        };
      },
    });
    router.service(SdkService, {
      getSdk: async () => {
        if (sdkFailure)
          throw new ConnectError('SDK unavailable', Code.Unavailable);
        await sdkDelay?.();
        return {
          files: [
            { path: 'import-map.json', content: Buffer.from('{"imports":{}}') },
          ],
        };
      },
    });
  },
});
const server = createServer(async (request, response) => {
  if (loseResponse && request.url?.endsWith('/DeployWorkflow')) {
    deploys++;
    request.socket.destroy();
    return;
  }
  await rpc(request, response);
});

function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env = {
    ...process.env,
    ...extra,
    HATCH_CLI_URL: origin,
    HATCH_CLI_TOKEN: token,
    HATCH_CLI_API_KEY: undefined,
    FORCE_COLOR: undefined,
  };
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', entry, ...args, '--json'],
    { env, stdio: 'pipe' },
  );
  child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const result = new Promise<{
    code: number | null;
    data: Record<string, any>;
    stderr: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({ code, data: stdout ? JSON.parse(stdout) : null, stderr }),
    );
  });
  return { child, result };
}
function git(root: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
async function create() {
  const file = join(directory, 'input.json');
  await writeFile(file, '{"slug":"fixture","name":"Fixture","pin":false}');
  const result = await run([
    'workflow',
    'create',
    '--file',
    file,
    '--directory',
    join(directory, 'source'),
  ]).result;
  assert.equal(result.code, 0, JSON.stringify(result));
  return join(directory, 'source');
}
async function publish(root: string) {
  const file = join(directory, 'remote.bundle');
  git(root, 'bundle', 'create', file, 'master');
  bundle = (await readFile(file)).toString('base64');
  master = git(root, 'rev-parse', 'HEAD');
}
function commit(root: string, message: string) {
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    message,
  );
}
// These tests launch real Git and package-manager processes, including on CI.
describe('CLI workspace safety', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    directory = await realpath(
      await mkdtemp(join(tmpdir(), 'hatch-cli-boundary-')),
    );
    generation = new Date().toISOString();
    bundle = null;
    master = null;
    deploys = 0;
    loseResponse = false;
    sdkDelay = undefined;
    sdkFailure = false;
    resourceSlug = 'fixture';
    createRequests = [];
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  it.each(['app', 'workflow'])(
    'creates a %s with a digit-leading slug in the default directory',
    async (kind) => {
      const input = {
        slug: `123-test-${kind}`,
        name: 'Test resource',
        pin: false,
      };
      const file = join(directory, 'input.json');
      await writeFile(file, JSON.stringify(input));

      const result = await run([
        kind,
        'create',
        '--file',
        file,
        '--workdir',
        directory,
      ]).result;

      // This fixture intentionally has no authored Deno configuration. App
      // registration must succeed, then preparation must retain its checkout.
      assert.equal(result.code, kind === 'app' ? 6 : 0, JSON.stringify(result));
      expect(createRequests).toEqual([input]);
      const root = join(directory, input.slug);
      expect(
        kind === 'app' ? result.data.error.message : result.data.directory,
      ).toContain(await realpath(root));
      expect(
        JSON.parse(await readFile(join(root, '.git/hatch-cli.json'), 'utf8')),
      ).toMatchObject({ kind, id: 'immutable' });
      expect(git(root, 'log', '-1', '--format=%s')).toBe('Initialize scaffold');
      expect(await readFile(join(root, '.hatch/import-map.json'), 'utf8')).toBe(
        '{"imports":{}}',
      );
    },
  );
  it.each(['app', 'workflow'])(
    'rejects unsafe %s slugs before creating remote or local state',
    async (kind) => {
      const file = join(directory, 'input.json');
      await writeFile(
        file,
        JSON.stringify({ slug: '../123-test-resource', name: 'Test resource' }),
      );

      const result = await run([
        kind,
        'create',
        '--file',
        file,
        '--workdir',
        directory,
      ]).result;

      expect(result.data.error.code).toBe('invalid_input');
      expect(createRequests).toEqual([]);
      expect(await readdir(directory)).toEqual(['input.json']);
    },
  );
  it('rejects malformed create field types before a remote mutation', async () => {
    const file = join(directory, 'input.json');
    await writeFile(file, JSON.stringify({ slug: 'valid-slug', name: 42 }));
    const result = await run([
      'workflow',
      'create',
      '--file',
      file,
      '--workdir',
      directory,
    ]).result;
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe('invalid_input');
    expect(createRequests).toEqual([]);
  });
  it('protects existing directories, dirty trees, generation and instance bindings', async () => {
    const root = await create();
    await publish(root);
    expect(
      (
        await run(['workflow', 'clone', 'immutable', '--directory', root])
          .result
      ).code,
    ).toBe(6);
    await writeFile(join(root, 'local.txt'), 'local work');
    expect(
      (await run(['workflow', 'update', '--directory', root]).result).data.error
        .code,
    ).toBe('dirty_workspace');
    expect(await readFile(join(root, 'local.txt'), 'utf8')).toBe('local work');
    commit(root, 'Keep local work');
    generation = new Date(Date.now() + 1000).toISOString();
    expect(
      (await run(['workflow', 'deploy', '--directory', root]).result).data.error
        .code,
    ).toBe('RESOURCE_GENERATION_CONFLICT');
    expect(deploys).toBe(0);
    const metadata = JSON.parse(
      await readFile(join(root, '.git/hatch-cli.json'), 'utf8'),
    );
    metadata.url = 'https://another.example.test';
    await writeFile(
      join(root, '.git/hatch-cli.json'),
      JSON.stringify(metadata),
    );
    expect(
      (await run(['workflow', 'update', '--directory', root]).result).data.error
        .code,
    ).toBe('workspace_instance_mismatch');
  });
  it('fast-forwards clones and fetches divergence without resetting local commits', async () => {
    const root = await create();
    await publish(root);
    const clone = join(directory, 'clone');
    expect(
      (
        await run(['workflow', 'clone', 'immutable', '--directory', clone])
          .result
      ).code,
    ).toBe(0);
    await writeFile(join(root, 'remote.txt'), 'remote');
    commit(root, 'Remote');
    await publish(root);
    expect(
      (await run(['workflow', 'update', '--directory', clone]).result).code,
    ).toBe(0);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(master);
    await writeFile(join(clone, 'local.txt'), 'local');
    commit(clone, 'Local');
    const local = git(clone, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'other.txt'), 'other');
    commit(root, 'Other');
    await publish(root);
    expect(
      (await run(['workflow', 'update', '--directory', clone]).result).data
        .error.code,
    ).toBe('non_fast_forward');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(local);
    expect(git(clone, 'rev-parse', 'FETCH_HEAD')).toBe(master);
  });
  it('replaces only explicit safe targets after preparation and restores existing work on failure', async () => {
    const source = await create();
    await publish(source);
    const target = join(directory, 'replace');
    await mkdir(target);
    await writeFile(join(target, 'local.txt'), 'valuable work');
    expect(
      (await run(['workflow', 'clone', 'immutable', '--force']).result).data
        .error.code,
    ).toBe('invalid_arguments');
    expect(
      (
        await run([
          'workflow',
          'clone',
          'immutable',
          '--directory',
          directory,
          '--workdir',
          directory,
          '--force',
        ]).result
      ).data.error.code,
    ).toBe('unsafe_target');
    expect(
      (
        await run([
          'workflow',
          'clone',
          'immutable',
          '--directory',
          '/',
          '--force',
        ]).result
      ).data.error.code,
    ).toBe('unsafe_target');
    const link = join(directory, 'linked');
    await symlink(target, link);
    expect(
      (
        await run([
          'workflow',
          'clone',
          'immutable',
          '--directory',
          link,
          '--force',
        ]).result
      ).data.error.code,
    ).toBe('unsafe_target');
    sdkFailure = true;
    const failed = await run([
      'workflow',
      'clone',
      'immutable',
      '--directory',
      target,
      '--force',
    ]).result;
    expect(failed.code).not.toBe(0);
    expect(await readFile(join(target, 'local.txt'), 'utf8')).toBe(
      'valuable work',
    );
    sdkFailure = false;
    const replaced = await run([
      'workflow',
      'clone',
      'immutable',
      '--directory',
      target,
      '--force',
    ]).result;
    expect(replaced.code).toBe(0);
    expect(replaced.data.replacedExisting).toBe(true);
    expect(git(target, 'rev-parse', 'HEAD')).toBe(master);
    expect(await readdir(target)).not.toContain('local.txt');
  });
  it('records uncertain deploy outcomes and never blindly retries', async () => {
    const root = await create();
    loseResponse = true;
    expect(
      (await run(['workflow', 'deploy', '--directory', root]).result).code,
    ).toBe(7);
    const pending = JSON.parse(
      await readFile(join(root, '.git/hatch-cli.json'), 'utf8'),
    ).pending;
    expect(pending.commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(
      (await run(['workflow', 'deploy', '--directory', root]).result).data.error
        .code,
    ).toBe('deployment_outcome_unknown');
    expect(
      (
        await run(['workflow', 'deploy', '--directory', root, '--reconcile'])
          .result
      ).data.state,
    ).toBe('outcome-unresolved');
    expect(deploys).toBe(1);
    loseResponse = false;
    expect(
      (
        await run([
          'workflow',
          'deploy',
          '--directory',
          root,
          '--retry-after-confirming',
          pending.commit,
        ]).result
      ).code,
    ).toBe(0);
    expect(deploys).toBe(2);
    expect(
      JSON.parse(await readFile(join(root, '.git/hatch-cli.json'), 'utf8'))
        .pending,
    ).toBeUndefined();
  });
  it('uses a cross-process lock and releases it after completion or POSIX cancellation', async () => {
    const root = await create();
    await publish(root);
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    sdkDelay = () => {
      started();
      return waiting;
    };
    const updating = run(['workflow', 'update', '--directory', root]);
    await startedPromise;
    expect(
      (await run(['workflow', 'deploy', '--directory', root]).result).data.error
        .code,
    ).toBe('workspace_locked');
    if (process.platform !== 'win32') updating.child.kill('SIGINT');
    release();
    expect((await updating.result).code).toBe(
      process.platform === 'win32' ? 0 : 130,
    );
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.lock')),
    ).toEqual([]);
  });
  it('keeps CLI, fleet, database and provider credentials out of dependency processes', async () => {
    const bin = join(directory, 'bin');
    await mkdir(bin);
    const captured = join(directory, 'child-env.json');
    const executable =
      process.platform === 'win32'
        ? join(bin, '.tools', 'pnpm 12 & literal', 'pnpm.cjs')
        : join(bin, 'pnpm');
    await mkdir(join(bin, '.tools', 'pnpm 12 & literal'), { recursive: true });
    if (process.platform === 'win32')
      await writeFile(
        join(bin, 'pnpm.cmd'),
        '@echo off\r\nnode "%~dp0.tools\\pnpm 12 & literal\\pnpm.cjs" %*\r\nexit /b 99\r\n',
      );
    await writeFile(
      executable,
      '#!/usr/bin/env node\n' +
        "require('node:fs').writeFileSync(" +
        JSON.stringify(captured) +
        ', JSON.stringify(Object.keys(process.env).filter(key => /TOKEN|SECRET|API_KEY|DATABASE_URL/.test(key))));\n',
      { mode: 0o755 },
    );
    const input = join(directory, 'input.json');
    await writeFile(input, '{"slug":"fixture","name":"Fixture"}');
    const result = await run(
      [
        'workflow',
        'create',
        '--file',
        input,
        '--directory',
        join(directory, 'source'),
      ],
      {
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        AGENT_RUNNER_TOKEN: 'fixture-fleet',
        DATABASE_URL: 'fixture-database',
        ANTHROPIC_API_KEY: 'fixture-provider',
      },
    ).result;
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(captured, 'utf8'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects tracked symlinks and leaves source unchanged',
    async () => {
      const root = await create();
      await symlink('manifest.ts', join(root, 'link'));
      commit(root, 'Symlink');
      const head = git(root, 'rev-parse', 'HEAD');
      expect(
        (await run(['workflow', 'deploy', '--directory', root]).result).data
          .error.code,
      ).toBe('unsafe_source');
      expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
      expect(deploys).toBe(0);
    },
  );
});
