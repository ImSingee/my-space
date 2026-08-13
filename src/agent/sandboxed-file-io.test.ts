import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = await mkdtemp(path.join(tmpdir(), 'hatch-file-env-'));
process.env.HATCH_DATA_DIR = root;

const { agentWorkDir } = await import('./paths');
const { prepareAgentSessionSandbox } = await import('./shell-sandbox');
const { SessionExecutionEnv } = await import('./sandboxed-file-io');

function createEnv(sessionId: string) {
  prepareAgentSessionSandbox(sessionId);
  return new SessionExecutionEnv({ sessionId, shellEnv: {} });
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('SessionExecutionEnv', () => {
  it('performs metadata, list, read, write, and append in its workdir', async () => {
    const env = createEnv('file-env-basic');
    expect(await env.canonicalPath('.')).toMatchObject({
      ok: true,
      value: env.cwd,
    });
    expect(await env.writeFile('nested/value.txt', 'one')).toMatchObject({
      ok: true,
    });
    expect(await env.appendFile('nested/value.txt', '-two')).toMatchObject({
      ok: true,
    });
    expect(await env.readTextFile('nested/value.txt')).toMatchObject({
      ok: true,
      value: 'one-two',
    });
    expect(await env.fileInfo('nested/value.txt')).toMatchObject({
      ok: true,
      value: { kind: 'file', name: 'value.txt' },
    });
    expect(await env.listDir('nested')).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ name: 'value.txt', kind: 'file' })],
    });
    expect(await env.createDir('nested', { recursive: true })).toMatchObject({
      ok: true,
    });

    await writeFile(path.join(env.cwd, 'script.sh'), '#!/bin/sh\n');
    await chmod(path.join(env.cwd, 'script.sh'), 0o755);
    expect(
      await env.writeFile('script.sh', '#!/bin/sh\necho ok\n'),
    ).toMatchObject({ ok: true });
    expect((await stat(path.join(env.cwd, 'script.sh'))).mode & 0o777).toBe(
      0o755,
    );

    await writeFile(path.join(env.cwd, 'lines.txt'), 'a\r\nb\rc\n');
    expect(await env.readTextLines('lines.txt')).toEqual({
      ok: true,
      value: ['a', 'b', 'c'],
    });
    expect(await env.readTextLines('lines.txt', { maxLines: 2 })).toEqual({
      ok: true,
      value: ['a', 'b'],
    });

    await writeFile(path.join(env.cwd, 'invalid.txt'), Uint8Array.of(0xff));
    expect(await env.readTextFile('invalid.txt')).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });

    const tempDirectory = await env.createTempDir('sandbox-');
    expect(tempDirectory).toMatchObject({ ok: true });
    if (!tempDirectory.ok) throw tempDirectory.error;
    expect(path.isAbsolute(tempDirectory.value)).toBe(true);
    expect(path.relative(env.cwd, tempDirectory.value)).not.toMatch(/^\.\./);
    const tempFile = await env.createTempFile({
      prefix: 'capture-',
      suffix: '.log',
    });
    expect(tempFile).toMatchObject({ ok: true });
    if (!tempFile.ok) throw tempFile.error;
    expect(path.isAbsolute(tempFile.value)).toBe(true);
    expect(path.relative(env.cwd, tempFile.value)).not.toMatch(/^\.\./);
  });

  it('reads configured resources without granting write access', async () => {
    const sessionId = 'file-env-resources';
    prepareAgentSessionSandbox(sessionId);
    const resources = path.join(root, 'resources');
    await mkdir(resources, { recursive: true });
    await writeFile(path.join(resources, 'guide.txt'), 'read only');
    const env = new SessionExecutionEnv({
      sessionId,
      shellEnv: {},
      readOnlyRoots: [resources],
    });

    expect(await env.readTextFile(path.join(resources, 'guide.txt'))).toEqual({
      ok: true,
      value: 'read only',
    });
    expect(
      await env.writeFile(path.join(resources, 'guide.txt'), 'changed'),
    ).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
  });

  it('allows in-root names beginning with two dots but rejects parent escapes', async () => {
    const env = createEnv('file-env-dotdot-name');

    expect(await env.writeFile('..config', 'inside')).toMatchObject({
      ok: true,
    });
    expect(await env.readTextFile('..config')).toEqual({
      ok: true,
      value: 'inside',
    });
    expect(await env.createDir('..cache')).toMatchObject({ ok: true });
    expect(await env.writeFile('..cache/value.txt', 'nested')).toMatchObject({
      ok: true,
    });

    expect(await env.writeFile('../escaped.txt', 'blocked')).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
    await expect(
      readFile(path.join(env.cwd, '..', 'escaped.txt')),
    ).rejects.toThrow(/ENOENT|no such file/);
  });

  it('returns an aborted result without starting a file operation', async () => {
    const env = createEnv('file-env-abort');
    const controller = new AbortController();
    controller.abort();
    expect(
      await env.writeFile('never.txt', 'no', controller.signal),
    ).toMatchObject({ ok: false, error: { code: 'aborted' } });
    await expect(readFile(path.join(env.cwd, 'never.txt'))).rejects.toThrow(
      /ENOENT|no such file/,
    );
  });

  it('cannot follow a symlink into another session or a host file', async () => {
    const first = createEnv('file-env-first');
    createEnv('file-env-second');
    const canary = 'cross-session-canary-never-returned';
    const otherEnv = path.join(agentWorkDir('file-env-second'), '.env');
    await writeFile(otherEnv, canary);
    await symlink(otherEnv, path.join(first.cwd, 'other-env'));
    const result = await first.readTextFile('other-env');
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
    expect(JSON.stringify(result)).not.toContain(canary);

    const host = path.join(root, 'host-secret');
    await writeFile(host, canary);
    await symlink(host, path.join(first.cwd, 'host-secret'));
    const hostResult = await first.readTextFile('host-secret');
    expect(hostResult).toMatchObject({ ok: false });
    expect(JSON.stringify(hostResult)).not.toContain(canary);
  });

  it('does not write through a replaced parent symlink', async () => {
    const env = createEnv('file-env-race');
    const parent = path.join(env.cwd, 'parent');
    const outside = path.join(root, 'outside');
    await mkdir(parent);
    await mkdir(outside);
    await rm(parent, { recursive: true });
    await symlink(outside, parent);

    expect(await env.writeFile('parent/escaped.txt', 'blocked')).toMatchObject({
      ok: false,
    });
    await expect(readFile(path.join(outside, 'escaped.txt'))).rejects.toThrow(
      /ENOENT|no such file/,
    );
  });
});
