/** The build embeds only audited official product guidance, never repo paths. */
export type SkillFiles = Record<string, string>;
export type OfficialSkill = {
  name: string;
  description: string;
  files: SkillFiles;
  dependencies: string[];
};
export type SkillBundle = {
  version: string;
  commit: string | null;
  digest: string;
  skills: OfficialSkill[];
};
declare const __HATCH_SKILL_BUNDLE__: SkillBundle;
export const bundledSkills = (): SkillBundle => {
  if (typeof __HATCH_SKILL_BUNDLE__ === 'undefined')
    throw new Error('Build the standalone CLI with pnpm build:cli first.');
  return __HATCH_SKILL_BUNDLE__;
};
