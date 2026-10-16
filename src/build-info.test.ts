import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBuildInfo } from '../scripts/build-info';

const commit = '1234567890abcdef1234567890abcdef12345678';
const commitTime = '2026-10-14T23:35:44+08:00';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('build metadata boundary', () => {
  it('uses a complete explicit revision without accessing a repository', () => {
    expect(
      resolveBuildInfo({
        env: {
          HATCH_BUILD_COMMIT: commit,
          HATCH_BUILD_COMMIT_TIME: commitTime,
        },
        cwd: '/missing-build-repository',
      }),
    ).toEqual({ commit, commitTime });
  });

  it('rejects partial or invalid injected revisions rather than falling back', () => {
    for (const env of [
      { HATCH_BUILD_COMMIT: commit },
      { HATCH_BUILD_COMMIT_TIME: commitTime },
      { HATCH_BUILD_COMMIT: 'bad-sha', HATCH_BUILD_COMMIT_TIME: commitTime },
      {
        HATCH_BUILD_COMMIT: commit,
        HATCH_BUILD_COMMIT_TIME: '2026-02-30T10:00:00Z',
      },
    ])
      expect(() => resolveBuildInfo({ env })).toThrow(/commit/);
  });

  it('reads the checked-out commit and committer time, independently of author time', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hatch-build-git-'));
    directories.push(cwd);
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Build fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.test',
          GIT_COMMITTER_NAME: 'Build fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.test',
          GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: commitTime,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git(['init']);
    git([
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'build fixture',
    ]);
    expect(resolveBuildInfo({ env: {}, cwd })).toEqual({
      commit: git(['rev-parse', 'HEAD']),
      commitTime,
    });
  });

  it('keeps source archives buildable with explicitly unknown metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hatch-build-archive-'));
    directories.push(cwd);
    expect(resolveBuildInfo({ env: {}, cwd })).toEqual({
      commit: null,
      commitTime: null,
    });
  });
});
