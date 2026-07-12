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
  it('lists visible skill metadata without eagerly including its body', () => {
    const prompt = buildSystemPrompt([visibleSkill]);

    expect(prompt).toContain('<available_skills>');
    expect(prompt).toContain('<name>building-apps</name>');
    expect(prompt).toContain('Build and modify Hatch apps.');
    expect(prompt).toContain('/opt/hatch/skills/building-apps/SKILL.md');
    expect(prompt).not.toContain('FULL_SKILL_BODY_SENTINEL');
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
