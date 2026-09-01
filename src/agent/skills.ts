import {
  loadSkills,
  type ExecutionEnv,
  type Skill,
  type SkillDiagnostic,
} from '@earendil-works/pi-agent-core';
import { SKILLS_DIR } from './paths';

const REQUIRED_SKILL_NAMES = [
  'building-apps',
  'building-workflows',
  'importing-apps',
  'importing-workflows',
  'app-compatibility',
  'workflow-compatibility',
] as const;

const WORKFLOW_SKILL_NAMES = new Set([
  'building-workflows',
  'importing-workflows',
  'workflow-compatibility',
]);

function formatDiagnostic(diagnostic: SkillDiagnostic): string {
  return `${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`;
}

/** Load and validate the first-party skills required by the Hatch Agent. */
export async function loadAgentSkills(
  env: ExecutionEnv,
  options: {
    workflowBetaEnabled: boolean;
    skillsDir?: string;
  },
): Promise<Skill[]> {
  const skillsDir = options.skillsDir ?? SKILLS_DIR;
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

  return options.workflowBetaEnabled
    ? skills
    : skills.filter((skill) => !WORKFLOW_SKILL_NAMES.has(skill.name));
}
