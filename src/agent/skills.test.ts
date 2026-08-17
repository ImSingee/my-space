import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { afterEach, describe, expect, it } from 'vitest';
import { SKILLS_DIR } from './paths';
import type { PlatformClient } from './platform-client';
import { loadAgentSkills } from './skills';
import { buildSystemPrompt } from './system-prompt';
import { createTools } from './tools';

const tempRoots: string[] = [];
const stubPlatform = {} as PlatformClient;
const appUrl = 'https://hatch.example.com';

function textOf(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Agent skills', () => {
  it('loads the required shipped skills without diagnostics', async () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const skills = await loadAgentSkills(env, SKILLS_DIR);

    expect(skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining([
        'building-apps',
        'building-workflows',
        'importing-apps',
        'importing-workflows',
      ]),
    );
  });

  it('keeps import guidance focused on review and delegates build rules', async () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const skills = await loadAgentSkills(env, SKILLS_DIR);
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    for (const [importName, buildName] of [
      ['importing-apps', 'building-apps'],
      ['importing-workflows', 'building-workflows'],
    ] as const) {
      const skill = byName.get(importName);
      expect(skill).toBeDefined();
      if (!skill) throw new Error(`Missing ${importName} Skill`);
      const { content } = skill;
      expect(content).toContain('read_file');
      expect(content).toContain(`\`${buildName}\``);
      expect(content).toContain('unzip');
      expect(content.indexOf(buildName)).toBeLessThan(
        content.indexOf('download_attachment'),
      );
      expect(content).not.toContain('deno install');
      expect(content).not.toContain('allowScripts');
    }
  });

  it('keeps building-apps concise and routes capability detail to references', async () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const skills = await loadAgentSkills(env, SKILLS_DIR);
    const skill = skills.find(({ name }) => name === 'building-apps');
    if (!skill) throw new Error('Missing building-apps Skill');

    expect(skill.content.split('\n').length).toBeLessThan(500);
    for (const reference of [
      'references/frontend-widgets.md',
      'references/backend-integrations.md',
      'references/data-storage.md',
    ]) {
      expect(skill.content).toContain(`](${reference})`);
    }
    expect(skill.content).toContain('.hatch/import-map.json');
    expect(skill.content).toContain('reserved case-insensitively');
    expect(skill.content).toContain('root `.npmrc` in any casing');
    expect(skill.content).toContain('`deno.jsonc`, `tsconfig.json`, or');
    expect(skill.content).toContain('`"type": "module"`');
    expect(skill.content).toContain('`compilerOptions.strict` to `true`');
    expect(skill.content).toContain(
      'Do not add `imports`, `scopes`, `importMap`',
    );
    expect(skill.content).toContain('createDataClient<typeof schema>');
    expect(skill.content).toContain('type JsonValue');
    expect(skill.content).toContain('.hatch/sdk/@hatch/data/package.json');
    expect(skill.content).toContain('Every relative TypeScript import');
    expect(skill.content).toContain(
      'deploy_app` performs the same source check',
    );
    expect(skill.content).toContain(
      'buf generate --template .hatch/buf.gen.yaml',
    );
    for (const command of ['deno test', 'deno run', 'deno cache']) {
      expect(skill.content).toMatch(
        new RegExp(
          `${command} --config=deno\\.json --no-remote ` +
            '--node-modules-dir=auto[\\s\\\\]*' +
            '--import-map=\\.hatch/import-map\\.json[\\s\\\\]*' +
            '--lock=deno\\.lock --frozen',
        ),
      );
    }
    expect(skill.content).toMatch(
      /deno check --config=deno\.json --no-remote --node-modules-dir=auto/,
    );
    expect(skill.content).not.toMatch(/^buf generate$/m);
    expect(skill.content).not.toContain('node_modules/@hatch');
    expect(skill.content).not.toContain('validate_app');
    expect(skill.content).not.toContain('sloppy-imports');
    expect(skill.content).toContain('Keep `deno.json` `allowScripts` empty');
    expect(skill.content).toContain(
      'App preparation and deploy do not\nexecute package',
    );
  });

  it('removes generated and platform-owned files from imported App archives', async () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const skills = await loadAgentSkills(env, SKILLS_DIR);
    const skill = skills.find(({ name }) => name === 'importing-apps');
    if (!skill) throw new Error('Missing importing-apps Skill');

    expect(skill.content).toContain('`.git`, `node_modules`,');
    expect(skill.content).toContain(
      '`.hatch` (including every casing variant)',
    );
    expect(skill.content).toContain('root `.npmrc` in any casing');
    expect(skill.content).toContain(
      'Do not copy root `deno.jsonc`, `tsconfig.json`, or `jsconfig.json`',
    );
    expect(skill.content).toMatch(
      /including explicit\s+`\.ts`\/`\.tsx` relative imports/,
    );
    expect(skill.content).toContain(
      'Run the codegen, dependency, source-check',
    );
    expect(skill.content).not.toContain('node_modules/@hatch');
  });

  it('advertises shipped skills that the registered read tool can load', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hatch-agent-work-'));
    tempRoots.push(root);
    const env = new NodeExecutionEnv({ cwd: root });
    const skills = await loadAgentSkills(env, SKILLS_DIR);
    const prompt = buildSystemPrompt(appUrl, skills);
    const readFileTool = createTools(env, {
      platform: stubPlatform,
      readOnlyRoots: [SKILLS_DIR],
    }).find((tool) => tool.name === 'read_file');
    if (!readFileTool) throw new Error('Missing read_file tool');

    for (const skill of skills) {
      expect(prompt).toContain(skill.filePath);
      const result = await readFileTool.execute('read', {
        path: skill.filePath,
      });
      expect(textOf(result)).toContain(skill.content);
    }
  });

  it('rejects an incomplete skill directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hatch-agent-skills-'));
    tempRoots.push(root);
    const appSkillDir = path.join(root, 'building-apps');
    await mkdir(appSkillDir, { recursive: true });
    await writeFile(
      path.join(appSkillDir, 'SKILL.md'),
      [
        '---',
        'name: building-apps',
        'description: Build Hatch apps.',
        '---',
        '',
        '# Building apps',
      ].join('\n'),
    );
    const env = new NodeExecutionEnv({ cwd: process.cwd() });

    await expect(loadAgentSkills(env, root)).rejects.toThrow(
      /missing required skill: building-workflows/,
    );
  });

  it('rejects shipped skills without the import safety procedures', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hatch-agent-skills-'));
    tempRoots.push(root);
    for (const name of ['building-apps', 'building-workflows']) {
      const skillDir = path.join(root, name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        [
          '---',
          `name: ${name}`,
          `description: ${name}`,
          '---',
          '',
          `# ${name}`,
        ].join('\n'),
      );
    }
    const env = new NodeExecutionEnv({ cwd: process.cwd() });

    await expect(loadAgentSkills(env, root)).rejects.toThrow(
      /missing required skill: importing-apps/,
    );
  });

  it('rejects skill loader diagnostics', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hatch-agent-skills-'));
    tempRoots.push(root);
    for (const name of ['building-apps', 'building-workflows']) {
      const skillDir = path.join(root, name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        [
          '---',
          `name: ${name}`,
          ...(name === 'building-apps'
            ? []
            : ['description: Build Hatch workflows.']),
          '---',
          '',
          `# ${name}`,
        ].join('\n'),
      );
    }
    const env = new NodeExecutionEnv({ cwd: process.cwd() });

    await expect(loadAgentSkills(env, root)).rejects.toThrow(
      /invalid_metadata.*description is required/s,
    );
  });
});
