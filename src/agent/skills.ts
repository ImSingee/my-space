import {
  loadSkills,
  type ExecutionEnv,
  type Skill,
  type SkillDiagnostic,
} from '@earendil-works/pi-agent-core';
import { SKILLS_DIR } from './paths';

const REQUIRED_SKILL_NAMES = ['building-apps', 'building-workflows'] as const;

function formatDiagnostic(diagnostic: SkillDiagnostic): string {
  return `${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`;
}

/** Load and validate the first-party skills required by the Hatch Agent. */
export async function loadAgentSkills(
  env: ExecutionEnv,
  skillsDir = SKILLS_DIR,
): Promise<Skill[]> {
  const { skills, diagnostics } = await loadSkills(env, skillsDir);
  const problems = diagnostics.map(formatDiagnostic);
  const names = new Set<string>();

  for (const skill of skills) {
    if (names.has(skill.name)) {
      problems.push(`duplicate skill name: ${skill.name}`);
    }
    names.add(skill.name);
  }

  for (const required of REQUIRED_SKILL_NAMES) {
    if (!names.has(required)) {
      problems.push(`missing required skill: ${required}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid Agent skill configuration:\n${problems
        .map((problem) => `- ${problem}`)
        .join('\n')}`,
    );
  }

  return skills;
}
