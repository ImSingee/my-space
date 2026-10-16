import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { BuildInfo } from '../src/build-info.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadataSchema = z.object({
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  commitTime: z.iso.datetime({ offset: true }),
});

export function resolveBuildInfo({
  env = process.env,
  cwd = root,
}: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): BuildInfo {
  const commit = env.HATCH_BUILD_COMMIT?.trim();
  const commitTime = env.HATCH_BUILD_COMMIT_TIME?.trim();
  if (commit || commitTime) {
    return metadataSchema.parse({ commit, commitTime });
  }

  let output: string;
  try {
    output = execFileSync('git', ['show', '-s', '--format=%H%n%cI', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return { commit: null, commitTime: null };
  }
  const [gitCommit, gitCommitTime] = output.trim().split(/\r?\n/);
  return metadataSchema.parse({ commit: gitCommit, commitTime: gitCommitTime });
}
