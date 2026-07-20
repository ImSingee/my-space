import type { Skill } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './system-prompt';

const visibleSkill: Skill = {
  name: 'building-apps',
  description: 'Build and modify Hatch apps.',
  content: 'FULL_SKILL_BODY_SENTINEL',
  filePath: '/opt/hatch/skills/building-apps/SKILL.md',
};

describe('Agent system prompt skills', () => {
  it('requires frontend route metadata to stay synchronized', () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toMatch(/Keep\s+`app\.routes`/);
    expect(prompt).toContain('{ path, description }');
    expect(prompt).toContain('$param');
    expect(prompt).toContain('not runtime route registration');
  });

  it('makes widgets responsive by default', () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toMatch(
      /Make widgets responsive by default\s+and omit `supportedSizes`/,
    );
    expect(prompt).toContain('verified discrete footprints');
  });

  it('limits automatic existing-checkout synchronization to safe fast-forwards', () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toMatch(/clean and on `master`.*fast-forward/s);
    expect(prompt).toContain('ahead or diverged local `master`');
    expect(prompt).toMatch(/Every other\s+existing target is preserved/);
  });

  it('lists visible skill metadata without eagerly including its body', () => {
    const prompt = buildSystemPrompt([visibleSkill]);

    expect(prompt).toContain('<available_skills>');
    expect(prompt).toContain('<name>building-apps</name>');
    expect(prompt).toContain('Build and modify Hatch apps.');
    expect(prompt).toContain('/opt/hatch/skills/building-apps/SKILL.md');
    expect(prompt).not.toContain('FULL_SKILL_BODY_SENTINEL');
  });

  it('requires import and build Skills before opening source archives', () => {
    const prompt = buildSystemPrompt([
      visibleSkill,
      {
        ...visibleSkill,
        name: 'building-workflows',
        filePath: '/opt/hatch/skills/building-workflows/SKILL.md',
      },
      {
        ...visibleSkill,
        name: 'importing-apps',
        filePath: '/opt/hatch/skills/importing-apps/SKILL.md',
      },
      {
        ...visibleSkill,
        name: 'importing-workflows',
        filePath: '/opt/hatch/skills/importing-workflows/SKILL.md',
      },
    ]);

    expect(prompt).toMatch(
      /importing-apps.*building-apps.*importing-workflows.*building-workflows/s,
    );
    expect(prompt).toMatch(/before downloading or extracting the attachment/i);
  });

  it('hides skills disabled for model invocation', () => {
    const prompt = buildSystemPrompt([
      { ...visibleSkill, disableModelInvocation: true },
    ]);

    expect(prompt).not.toContain('<available_skills>');
    expect(prompt).not.toContain('<name>building-apps</name>');
  });

  it('does not render an empty skill section', () => {
    expect(buildSystemPrompt()).not.toContain('<available_skills>');
  });
});
