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
      expect.arrayContaining(['building-apps', 'building-workflows']),
    );
  });

  it('advertises shipped skills that the registered read tool can load', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hatch-agent-work-'));
    tempRoots.push(root);
    const env = new NodeExecutionEnv({ cwd: root });
    const skills = await loadAgentSkills(env, SKILLS_DIR);
    const prompt = buildSystemPrompt(skills);
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
