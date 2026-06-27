/** Server-only: produce downloadable archives of an app's Git-backed source. */
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appArtifactsDir,
  appRepoDir,
  appVersionsDir,
  deploymentArtifactDir,
  deploymentBuildDir,
} from '~agent/paths';
import { APP_SOURCE_BRANCH, appMasterCommit, ensureAppRepo } from './git';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export type AppArchive = {
  filename: string;
  contentType: string;
  body: Buffer;
};

type SpawnResult = { code: number; stdout: Buffer; stderr: string };

/**
 * Spawn a command and capture stdout as a Buffer (binary-safe — the git.ts
 * helper decodes stdout as UTF-8, which would corrupt zip/tar bytes).
 */
function spawnCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

async function requireMaster(id: string): Promise<void> {
  await ensureAppRepo(id);
  const master = await appMasterCommit(id);
  if (!master) {
    throw new Error(
      `App "${id}" has no committed source yet — deploy it at least once ` +
        'before downloading.',
    );
  }
}

/**
 * The latest source as a zip of the `master` tree (no Git history) — equivalent
 * to a clean checkout. Uses `git archive`, whose zip writer is built in, so no
 * `zip` binary is required.
 */
export async function buildAppSourceArchive(id: string): Promise<AppArchive> {
  await requireMaster(id);
  const repoDir = appRepoDir(id);
  const res = await spawnCapture('git', [
    '--git-dir',
    repoDir,
    'archive',
    '--format=zip',
    `--prefix=${id}/`,
    APP_SOURCE_BRANCH,
  ]);
  if (res.code !== 0) {
    throw new Error(`Failed to archive source: ${res.stderr.trim()}`);
  }
  return {
    filename: `${id}-source.zip`,
    contentType: 'application/zip',
    body: res.stdout,
  };
}

/**
 * The complete repository as a gzipped tarball: a `master` checkout plus the
 * full `.git` directory (all history commits and deploy tags). Clones the bare
 * repo into a temp dir, drops the server-local `origin` remote, then tars it.
 */
export async function buildAppRepoArchive(id: string): Promise<AppArchive> {
  await requireMaster(id);
  const repoDir = appRepoDir(id);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'hatch-repo-'));
  try {
    const cloneDir = path.join(tmp, id);
    const clone = await spawnCapture('git', ['clone', repoDir, cloneDir]);
    if (clone.code !== 0) {
      throw new Error(`Failed to clone repo: ${clone.stderr.trim()}`);
    }
    // The origin points at a server-local path that means nothing to the user.
    await spawnCapture('git', ['-C', cloneDir, 'remote', 'remove', 'origin']);

    const tar = await spawnCapture('tar', ['-czf', '-', '-C', tmp, id]);
    if (tar.code !== 0) {
      throw new Error(`Failed to package repo: ${tar.stderr.trim()}`);
    }
    return {
      filename: `${id}-repo.tar.gz`,
      contentType: 'application/gzip',
      body: tar.stdout,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * A single deployment's built artifact as a gzipped tarball. The artifact is a
 * plain directory snapshot (the exact files that were served), so we tar it
 * directly — unlike source/repo it has no Git ref to `git archive`. Falls back
 * to the legacy per-deployment snapshot dir for pre-artifact deployments.
 */
export async function buildDeploymentArtifactArchive(
  id: string,
  deploymentId: string,
  version: number,
): Promise<AppArchive> {
  const useArtifact = await pathExists(deploymentArtifactDir(id, deploymentId));
  const parent = useArtifact ? appArtifactsDir(id) : appVersionsDir(id);
  const dir = useArtifact
    ? deploymentArtifactDir(id, deploymentId)
    : deploymentBuildDir(id, deploymentId);
  if (!(await pathExists(dir))) {
    throw new Error(`No artifact exists for v${version}.`);
  }
  const tar = await spawnCapture('tar', [
    '-czf',
    '-',
    '-C',
    parent,
    deploymentId,
  ]);
  if (tar.code !== 0) {
    throw new Error(`Failed to package artifact: ${tar.stderr.trim()}`);
  }
  return {
    filename: `${id}-v${version}-artifact.tar.gz`,
    contentType: 'application/gzip',
    body: tar.stdout,
  };
}
