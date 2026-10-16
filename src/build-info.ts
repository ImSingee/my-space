export type BuildInfo = {
  commit: string | null;
  commitTime: string | null;
};

declare const __HATCH_BUILD_INFO__: BuildInfo;

export const buildInfo: BuildInfo =
  typeof __HATCH_BUILD_INFO__ === 'undefined'
    ? { commit: null, commitTime: null }
    : __HATCH_BUILD_INFO__;
