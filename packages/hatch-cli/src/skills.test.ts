/** Durable installed-package, containment, conflict, crash and concurrency contracts. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  access,
  cp,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { loadSkills } from '@earendil-works/pi-agent-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCliSkills } from '../../../scripts/cli-skills';
import { installSkills } from './skills';
import { pnpmInvocation } from './pnpm';
import manifest from '../package.json' with { type: 'json' };

describe('official Skill installation', { timeout: 30000 }, () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  let root: string;
  let binary: string;
  const children: ChildProcess[] = [];
  const env = {
    ...process.env,
    HATCH_CLI_URL: 'invalid',
    HATCH_CLI_TOKEN: 'must-not-copy-test-secret',
    HATCH_CLI_API_KEY: 'invalid',
  };
  async function project() {
    return mkdtemp(join(root, 'project-'));
  }
  function cli(cwd: string, args: string[], preload?: string) {
    try {
      const stdout = execFileSync(
        process.execPath,
        [...(preload ? ['--import', preload] : []), binary, ...args, '--json'],
        { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { status: 0, result: JSON.parse(stdout) };
    } catch (error) {
      const result = error as { status: number; stdout: string };
      return {
        status: result.status,
        result: JSON.parse(String(result.stdout)),
      };
    }
  }
  async function present(path: string) {
    return access(path).then(
      () => true,
      () => false,
    );
  }
  async function waitFor(path: string) {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (await present(path)) return;
      await setTimeout(10);
    }
    throw new Error('Timed out waiting for the installed CLI fault boundary.');
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hatch-skills-package-'));
    const pnpm = await pnpmInvocation();
    execFileSync(
      process.execPath,
      [join(repo, 'node_modules/tsx/dist/cli.mjs'), 'scripts/build-cli.ts'],
      { cwd: repo, stdio: 'pipe' },
    );
    execFileSync(
      pnpm.executable,
      [
        ...pnpm.prefix,
        '--dir',
        join(repo, 'packages/hatch-cli'),
        'pack',
        '--pack-destination',
        root,
      ],
      { cwd: repo, stdio: 'pipe' },
    );
    const tarball = (await readdir(root)).find((file) =>
      file.endsWith('.tgz'),
    )!;
    const installed = join(root, 'installed');
    await mkdir(installed);
    await writeFile(join(installed, 'package.json'), '{"private":true}');
    execFileSync(
      pnpm.executable,
      [
        ...pnpm.prefix,
        '--dir',
        installed,
        'add',
        '--ignore-scripts',
        '--offline',
        join(root, tarball),
      ],
      { cwd: root, stdio: 'pipe' },
    );
    binary = join(installed, 'node_modules/@hatch/cli/dist/main.mjs');
  }, 60000);
  afterAll(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('installs the offline tarball default with valid metadata and every relative resource', async () => {
    const cwd = await project();
    const listed = cli(cwd, ['skills', 'list']);
    expect(listed.status).toBe(0);
    expect(listed.result.skills).toHaveLength(6);
    expect(await present(join(cwd, '.agents'))).toBe(false);
    const installed = cli(cwd, ['skills', 'install']);
    expect(installed.status).toBe(0);
    const destination = join(cwd, '.agents/skills');
    const loaded = await loadSkills(new NodeExecutionEnv({ cwd }), destination);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.skills).toHaveLength(6);
    for (const skill of listed.result.skills as {
      name: string;
      files: string[];
    }[]) {
      for (const file of skill.files) {
        const source = await readFile(
          join(destination, skill.name, file),
          'utf8',
        );
        expect(source).not.toContain(env.HATCH_CLI_TOKEN);
        expect(source).not.toMatch(
          /\b(?:list_apps|get_app|create_app|checkout_app|deploy_app|query_app_\w+|list_workflows|get_workflow|checkout_workflow|create_workflow|deploy_workflow|download_attachment|read_file)\b/,
        );
        for (const link of source.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
          if (/^[a-z]+:/.test(link[1])) continue;
          expect(
            await present(
              resolve(dirname(join(destination, skill.name, file)), link[1]),
            ),
          ).toBe(true);
        }
      }
    }
    const again = cli(cwd, ['skills', 'install', '-y']);
    expect(again.status).toBe(0);
    expect(
      again.result.skills.every(
        (skill: { status: string }) => skill.status === 'unchanged',
      ),
    ).toBe(true);
    expect(await present(join(cwd, '.agents/.hatch-skills-install'))).toBe(
      false,
    );
  });

  it('selects required sibling rules and preserves hand edits and unrelated Skills', async () => {
    const cwd = await project();
    const selected = cli(cwd, [
      'skills',
      'install',
      '-s',
      'importing-workflows',
    ]);
    expect(selected.status).toBe(0);
    expect(
      selected.result.skills
        .map((skill: { name: string }) => skill.name)
        .sort(),
    ).toEqual([
      'app-compatibility',
      'building-apps',
      'building-workflows',
      'importing-workflows',
      'workflow-compatibility',
    ]);
    const skills = join(cwd, '.agents/skills');
    await mkdir(join(skills, 'unrelated'));
    await writeFile(join(skills, 'unrelated/notes.txt'), 'preserve');
    await writeFile(join(skills, 'building-workflows/SKILL.md'), 'hand edited');
    const conflict = cli(cwd, [
      'skills',
      'install',
      'building-workflows',
      '--yes',
    ]);
    expect(conflict.result.error.code).toBe('skill_conflict');
    expect(conflict.status).not.toBe(0);
    expect(
      await readFile(join(skills, 'building-workflows/SKILL.md'), 'utf8'),
    ).toBe('hand edited');
    const replaced = cli(cwd, [
      'skills',
      'install',
      'building-workflows',
      '--replace',
    ]);
    expect(replaced.status).toBe(0);
    expect(await readFile(join(skills, 'unrelated/notes.txt'), 'utf8')).toBe(
      'preserve',
    );
    await mkdir(join(skills, 'building-workflows/hand-added-empty-directory'));
    expect(
      cli(cwd, ['skills', 'install', 'building-workflows']).result.error.code,
    ).toBe('skill_conflict');
  });

  it('rejects unknown selections, traversal, invalid metadata and escaping resource paths before writes', async () => {
    const cwd = await project();
    for (const name of ['../escape', '/absolute', 'BadName', 'missing-skill']) {
      expect(cli(cwd, ['skills', 'install', name]).status).not.toBe(0);
      expect(await present(join(cwd, '.agents'))).toBe(false);
    }
    const bundle = await buildCliSkills(repo, manifest.version, null);
    for (const mutate of [
      (copy: typeof bundle) => {
        copy.skills[0].files['../escape'] = '';
      },
      (copy: typeof bundle) => {
        copy.skills[0].files['SKILL.md'] = Buffer.from(
          '---\nname: wrong\ndescription: invalid\n---\n',
        ).toString('base64');
      },
    ]) {
      const copy = structuredClone(bundle);
      mutate(copy);
      await expect(
        installSkills(copy, [], { cwd, signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: 'invalid_bundle' });
      expect(await present(join(cwd, '.agents'))).toBe(false);
    }
  });

  it('rejects symlink boundaries and nested links even with explicit replacement', async () => {
    const outside = await project();
    for (const boundary of [
      '.agents',
      '.agents/skills',
      '.agents/skills/building-apps',
      '.agents/skills/building-apps/references',
    ]) {
      const cwd = await project();
      const target = join(cwd, boundary);
      await mkdir(dirname(target), { recursive: true });
      await symlink(outside, target, 'junction');
      const result = cli(cwd, [
        'skills',
        'install',
        'building-apps',
        '--replace',
      ]);
      expect(result.status).not.toBe(0);
      expect(result.result.error.code).toBe('unsafe_path');
      expect(await readdir(outside)).toEqual([]);
    }
  });

  it('rolls back every selected Skill on an actual filesystem swap failure', async () => {
    const cwd = await project();
    const skills = join(cwd, '.agents/skills');
    await mkdir(join(skills, 'building-apps'), { recursive: true });
    await writeFile(join(skills, 'building-apps/SKILL.md'), 'previous');
    const preload = join(cwd, 'fail.mjs');
    await writeFile(
      preload,
      `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.rename; fs.rename=async (a,b)=>{if(String(a).includes('/stage/app-compatibility'))throw Object.assign(new Error('injected disk failure'),{code:'EIO'}); return original(a,b)};syncBuiltinESMExports();`,
    );
    const result = cli(
      cwd,
      ['skills', 'install', 'building-apps', '--replace'],
      preload,
    );
    expect(result.status).not.toBe(0);
    expect(await readFile(join(skills, 'building-apps/SKILL.md'), 'utf8')).toBe(
      'previous',
    );
    expect(await present(join(skills, 'app-compatibility'))).toBe(false);
    expect(await present(join(cwd, '.agents/.hatch-skills-install'))).toBe(
      false,
    );
  });

  async function interrupted(cwd: string, args: string[]) {
    const marker = join(cwd, 'paused');
    const preload = join(cwd, 'pause.mjs');
    await writeFile(
      preload,
      `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.rename; fs.rename=async(a,b)=>{const value=await original(a,b);if(String(b).endsWith('/skills/building-apps')){await fs.writeFile(${JSON.stringify(marker)},'paused');await new Promise(()=>setInterval(()=>{},1000))}return value};syncBuiltinESMExports();`,
    );
    const child = spawn(
      process.execPath,
      ['--import', preload, binary, 'skills', 'install', ...args, '--json'],
      { cwd, env, stdio: 'ignore' },
    );
    children.push(child);
    await waitFor(marker);
    return child;
  }

  it('rejects concurrent install/recovery and recovers a killed replacement without hiding local changes', async () => {
    const cwd = await project();
    const target = join(cwd, '.agents/skills/building-apps');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), 'previous');
    const child = await interrupted(cwd, ['building-apps', '--replace']);
    expect(cli(cwd, ['skills', 'install']).result.error.code).toBe(
      'skills_locked',
    );
    expect(cli(cwd, ['skills', 'install', '--recover']).result.error.code).toBe(
      'skills_locked',
    );
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    expect(cli(cwd, ['skills', 'install']).result.error.code).toBe(
      'skills_locked',
    );
    const journalPath = join(cwd, '.agents/.hatch-skills-install/journal.json');
    const originalJournal = await readFile(journalPath, 'utf8');
    const unsafeJournal = JSON.parse(originalJournal);
    unsafeJournal.changes[0].name = 'unrelated';
    await writeFile(journalPath, JSON.stringify(unsafeJournal));
    expect(cli(cwd, ['skills', 'install', '--recover']).result.error.code).toBe(
      'recovery_required',
    );
    await writeFile(journalPath, originalJournal);
    await writeFile(join(target, 'after-crash.txt'), 'preserve');
    expect(cli(cwd, ['skills', 'install', '--recover']).result.error.code).toBe(
      'recovery_required',
    );
    expect(await readFile(join(target, 'after-crash.txt'), 'utf8')).toBe(
      'preserve',
    );
    await rm(join(target, 'after-crash.txt'));
    // Recovery first restores the previous version. Without --replace that edit
    // then conflicts, proving it was restored rather than discarded.
    const recoveryMarker = join(cwd, 'recovery-paused');
    const release = join(cwd, 'release-recovery');
    const preloader = join(cwd, 'recover-pause.mjs');
    await writeFile(
      preloader,
      `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const original=fs.rename;fs.rename=async(a,b)=>{const value=await original(a,b);if(String(a).includes('/backup/building-apps')){await fs.writeFile(${JSON.stringify(recoveryMarker)},'paused');while(!await fs.access(${JSON.stringify(release)}).then(()=>true,()=>false)){await new Promise(resolve=>setTimeout(resolve,10));}}return value};syncBuiltinESMExports();`,
    );
    const recovery = spawn(
      process.execPath,
      [
        '--import',
        preloader,
        binary,
        'skills',
        'install',
        'building-apps',
        '--recover',
        '--json',
      ],
      { cwd, env, stdio: 'ignore' },
    );
    children.push(recovery);
    await waitFor(recoveryMarker);
    expect(
      cli(cwd, ['skills', 'install', 'building-apps', '--recover']).result.error
        .code,
    ).toBe('skills_locked');
    const recoveredExit = once(recovery, 'exit');
    await writeFile(release, 'continue');
    expect((await recoveredExit)[0]).toBe(6);
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('previous');
    expect(
      cli(cwd, ['skills', 'install', 'building-apps', '--replace']).status,
    ).toBe(0);
  });

  it('restores an interrupted fresh installation and handles graceful cancellation', async () => {
    const cwd = await project();
    const child = await interrupted(cwd, ['building-apps']);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const recovered = cli(cwd, [
      'skills',
      'install',
      'building-apps',
      '--recover',
    ]);
    expect(recovered.status).toBe(0);
    expect(recovered.result.recovered).toBe(true);
    const cancelled = await project();
    const bundle = await buildCliSkills(repo, manifest.version, null);
    const controller = new AbortController();
    controller.abort();
    await expect(
      installSkills(bundle, [], { cwd: cancelled, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled', exitCode: 130 });
    expect(await readdir(join(cancelled, '.agents/skills'))).toEqual([]);
    expect(
      await present(join(cancelled, '.agents/.hatch-skills-install')),
    ).toBe(false);
  });

  it('keeps help, version and unsupported CLI behavior available in the installed package', async () => {
    const cwd = await project();
    expect(cli(cwd, ['help', 'skills']).result.commands).toHaveLength(2);
    expect(
      cli(cwd, ['skills', 'install', '--help']).result.commands,
    ).toHaveLength(1);
    expect(cli(cwd, ['version']).result.version).toBe(manifest.version);
    expect(cli(cwd, ['operation', 'get', 'missing']).result.error.code).toBe(
      'unsupported_command',
    );
    expect(
      cli(cwd, ['skills', 'install', '--all', 'building-apps']).result.error
        .code,
    ).toBe('invalid_arguments');
    expect(
      cli(cwd, ['skills', 'install', '--list']).result.skills,
    ).toHaveLength(6);
    expect(
      cli(cwd, ['skills', 'list', '--profile', 'secret']).result.error.code,
    ).toBe('invalid_arguments');
    expect(await present(join(cwd, '.agents'))).toBe(false);
  });

  it('packages supporting script and binary asset bytes without executing them and rejects unsafe official sources', async () => {
    const fixture = await project();
    for (const name of ['skills', 'packages/hatch-cli/skills']) {
      await mkdir(dirname(join(fixture, name)), { recursive: true });
      await cp(join(repo, name), join(fixture, name), { recursive: true });
    }
    const source = join(fixture, 'skills/building-apps');
    await mkdir(join(source, 'scripts'));
    await mkdir(join(source, 'assets'));
    const asset = Buffer.from([0, 255, 128, 42]);
    await writeFile(join(source, 'assets/payload.bin'), asset);
    await writeFile(
      join(source, 'scripts/probe.sh'),
      '#!/bin/sh\ntouch MUST-NOT-EXECUTE\n',
    );
    const bundle = await buildCliSkills(fixture, manifest.version, null);
    const destination = await project();
    await installSkills(bundle, ['building-apps'], {
      cwd: destination,
      signal: new AbortController().signal,
    });
    expect(
      await readFile(
        join(destination, '.agents/skills/building-apps/assets/payload.bin'),
      ),
    ).toEqual(asset);
    expect(
      await readFile(
        join(destination, '.agents/skills/building-apps/scripts/probe.sh'),
        'utf8',
      ),
    ).toContain('MUST-NOT-EXECUTE');
    expect(await present(join(destination, 'MUST-NOT-EXECUTE'))).toBe(false);
    await symlink(
      join(source, 'assets/payload.bin'),
      join(source, 'assets/link.bin'),
    );
    await expect(
      buildCliSkills(fixture, manifest.version, null),
    ).rejects.toThrow('symlinks');
    await rm(join(source, 'assets/link.bin'));
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: building-apps\ndescription: []\n---\n',
    );
    await expect(
      buildCliSkills(fixture, manifest.version, null),
    ).rejects.toThrow('metadata');
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: wrong\ndescription: wrong\n---\n',
    );
    await expect(
      buildCliSkills(fixture, manifest.version, null),
    ).rejects.toThrow('metadata');
  });

  it('restores old content when SIGTERM arrives after the first published Skill', async () => {
    const cwd = await project();
    const target = join(cwd, '.agents/skills/building-apps');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), 'previous');
    const preload = join(cwd, 'cancel.mjs');
    await writeFile(
      preload,
      `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.rename; let fired=false; fs.rename=async(a,b)=>{const value=await original(a,b);if(!fired && String(b).endsWith('/skills/building-apps')){fired=true;process.kill(process.pid,'SIGTERM');await new Promise(resolve=>setTimeout(resolve,20));}return value;};syncBuiltinESMExports();`,
    );
    const result = cli(
      cwd,
      ['skills', 'install', 'building-apps', '--replace'],
      preload,
    );
    expect(result.status).toBe(130);
    expect(result.result.error.code).toBe('cancelled');
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('previous');
    expect(await present(join(cwd, '.agents/skills/app-compatibility'))).toBe(
      false,
    );
    expect(await present(join(cwd, '.agents/.hatch-skills-install'))).toBe(
      false,
    );
  });
});
