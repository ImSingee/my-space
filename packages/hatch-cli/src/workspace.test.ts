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
const token = 'private-workspace-test-secret';
const server = createServer(async (request, response) => {
  const body: Buffer[] = [];
  for await (const chunk of request) body.push(chunk);
  const data = body.length ? JSON.parse(Buffer.concat(body).toString()) : {};
  const row = {
    id: 'immutable',
    slug: 'fixture',
    name: 'Fixture',
    description: null,
    status: 'draft',
    createdAt: generation,
    updatedAt: generation,
  };
  const send = (value: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (request.headers.authorization !== `Bearer ${token}`) {
    send(
      {
        defined: true,
        code: 'UNAUTHORIZED',
        status: 401,
        message: 'Authentication required.',
      },
      401,
    );
    return;
  }
  if (request.url === '/api/v1/workflows' && request.method === 'POST')
    send(
      {
        id: row.id,
        slug: row.slug,
        name: row.name,
        files: [
          {
            path: 'package.json',
            contentBase64: Buffer.from(
              '{"type":"module","dependencies":{}}',
            ).toString('base64'),
          },
          {
            path: 'manifest.ts',
            contentBase64: Buffer.from(
              'export default {id:"immutable", compatibilityVersion:1};',
            ).toString('base64'),
          },
        ],
      },
      201,
    );
  else if (request.url === '/api/v1/workflows/immutable') send(row);
  else if (request.url === '/api/v1/workflows/immutable/source')
    send({ id: row.id, masterCommit: master, bundleBase64: bundle });
  else if (request.url === '/api/v1/sdk/workflow') {
    await sdkDelay?.();
    send({
      files: [
        {
          path: 'import-map.json',
          contentBase64: Buffer.from('{"imports":{}}').toString('base64'),
        },
      ],
    });
  } else if (request.url === '/api/v1/workflows/immutable/deploy') {
    deploys++;
    if (loseResponse) {
      request.socket.destroy();
      return;
    }
    const file = join(directory, 'uploaded.bundle');
    await writeFile(file, Buffer.from(data.bundleBase64, 'base64'));
    const refs = execFileSync('git', ['bundle', 'list-heads', file], {
      encoding: 'utf8',
    });
    master = refs.trim().split(' ')[0];
    send({ deploymentId: 'release-1', version: 1, compatibilityVersion: 1 });
  } else
    send(
      {
        defined: true,
        code: 'NOT_FOUND',
        status: 404,
        message: 'Resource not found.',
      },
      404,
    );
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
describe('CLI workspace safety', () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hatch-cli-boundary-'));
    generation = new Date().toISOString();
    bundle = null;
    master = null;
    deploys = 0;
    loseResponse = false;
    sdkDelay = undefined;
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
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
