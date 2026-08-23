/** Server-only identity check for the mutable live build directory. */
import { promises as fs, readFileSync, type Stats } from 'node:fs';
import path from 'node:path';
import {
  appBuildDir,
  deploymentArtifactDir,
  deploymentBuildDir,
} from '~agent/paths';
import { db } from '~/db';

export type DeploymentMarker =
  | { kind: 'deployment'; id: string }
  | { kind: 'missing' }
  | { kind: 'invalid' };

export type LiveBuildFileResult =
  | { ok: true; data: Buffer }
  | { ok: false; reason: 'not_found' | 'unavailable' };

function parseDeploymentMarker(raw: string): DeploymentMarker {
  try {
    const value = JSON.parse(raw) as { deploymentId?: unknown };
    return typeof value.deploymentId === 'string' && value.deploymentId
      ? { kind: 'deployment', id: value.deploymentId }
      : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

async function readDeploymentMarker(file: string): Promise<DeploymentMarker> {
  try {
    return parseDeploymentMarker(await fs.readFile(file, 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'invalid' };
  }
}

/** Synchronous marker read used before spawning a backend process. */
export function readBuildDeploymentMarker(buildDir: string): DeploymentMarker {
  try {
    return parseDeploymentMarker(
      readFileSync(path.join(buildDir, 'deployment.json'), 'utf8'),
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'invalid' };
  }
}

function markerMatches(
  marker: DeploymentMarker,
  expectedDeploymentId: string,
  allowMissing: boolean,
): boolean {
  return marker.kind === 'deployment'
    ? marker.id === expectedDeploymentId
    : marker.kind === 'missing' && allowMissing;
}

function sameMarker(a: DeploymentMarker, b: DeploymentMarker): boolean {
  return (
    a.kind === b.kind &&
    (a.kind !== 'deployment' || (b.kind === 'deployment' && a.id === b.id))
  );
}

/**
 * A missing marker is legacy-compatible only when the deployment record
 * predates the marker/Data Table feature and either its immutable snapshot is
 * markerless or it predates snapshots as well. Current builds always carry the
 * capability key and marker, so deleting only deployment.json fails closed.
 */
async function deploymentAllowsMissingMarker(
  id: string,
  expectedDeploymentId: string,
): Promise<boolean> {
  const deployment = await db.query.deployments
    .findFirst({
      where: (row, { and, eq }) =>
        and(eq(row.id, expectedDeploymentId), eq(row.appId, id)),
      columns: { artifactPath: true, manifestNormalized: true },
    })
    .catch(() => undefined);
  if (!deployment) return false;

  // deployment.json and the Data Table capability shipped together. The
  // capability key therefore gives us durable version evidence even if only
  // the marker file was deleted from an otherwise intact modern artifact.
  const manifest = deployment.manifestNormalized;
  const capabilities =
    manifest && typeof manifest === 'object' && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>).capabilities
      : undefined;
  if (
    capabilities &&
    typeof capabilities === 'object' &&
    !Array.isArray(capabilities) &&
    Object.hasOwn(capabilities, 'dataTable')
  ) {
    return false;
  }

  let foundMarkerlessSnapshot = false;
  for (const root of [
    deploymentArtifactDir(id, expectedDeploymentId),
    deploymentBuildDir(id, expectedDeploymentId),
  ]) {
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) return false;
    } catch (error) {
      if (isMissingFileError(error)) continue;
      return false;
    }
    const marker = await readDeploymentMarker(
      path.join(root, 'deployment.json'),
    );
    if (marker.kind !== 'missing') return false;
    foundMarkerlessSnapshot = true;
  }
  if (foundMarkerlessSnapshot) return true;

  // Some deployments predate immutable snapshots entirely. Their nullable
  // artifactPath is durable positive evidence that a live-only markerless tree
  // is genuinely legacy. Conversely, a modern deployment record whose
  // artifact disappeared must fail closed rather than treating damage as age.
  return deployment.artifactPath === null;
}

type StableFileStat = Stats;

function sameFile(a: StableFileStat, b: StableFileStat): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function classifyMissingLiveFile(
  filePath: string,
  markerPath: string,
  markerBefore: DeploymentMarker,
  expectedDeploymentId: string,
  allowMissing: boolean,
): Promise<'not_found' | 'unavailable'> {
  try {
    await fs.stat(filePath);
    return 'unavailable';
  } catch (error) {
    if (!isMissingFileError(error)) return 'unavailable';
  }

  const markerAfter = await readDeploymentMarker(markerPath);
  return sameMarker(markerBefore, markerAfter) &&
    markerMatches(markerAfter, expectedDeploymentId, allowMissing)
    ? 'not_found'
    : 'unavailable';
}

/**
 * Confirm that the live marker is compatible with the selected deployment.
 *
 * Artifacts created before deployment markers existed remain compatible when
 * the marker is absent. Every current deploy/rollback writes the marker before
 * its bytes can be served, so a present malformed/mismatched marker is a hard
 * fail-closed signal rather than a legacy artifact. Serving code must use
 * {@link readLiveBuildFile}, which also binds the file read to this identity;
 * this marker-only check is not safe as a separate preflight for a later read.
 */
export async function liveBuildMatchesDeployment(
  id: string,
  expectedDeploymentId: string,
): Promise<boolean> {
  return buildMatchesDeployment(id, expectedDeploymentId, appBuildDir(id));
}

/** Validate an immutable, legacy-snapshot, or live runtime build directory. */
export async function buildMatchesDeployment(
  id: string,
  expectedDeploymentId: string,
  buildDir: string,
): Promise<boolean> {
  const marker = await readDeploymentMarker(
    path.join(buildDir, 'deployment.json'),
  );
  const allowMissing =
    marker.kind === 'missing' &&
    (await deploymentAllowsMissingMarker(id, expectedDeploymentId));
  return markerMatches(marker, expectedDeploymentId, allowMissing);
}

/**
 * Read one live build file without separating identity validation from the read.
 *
 * A deployment replaces the whole live directory. Checking only its marker and
 * then calling `readFile(path)` leaves a race where the path can switch to a new
 * deployment (and even switch back after a failed COMMIT) between those calls.
 * Pin the opened file descriptor and require the path, file metadata, and marker
 * to remain unchanged across the read. A concurrent cutover therefore yields a
 * retryable unavailable result instead of bytes from the wrong deployment.
 */
export async function readLiveBuildFile(
  id: string,
  expectedDeploymentId: string,
  relativePath: string,
): Promise<LiveBuildFileResult> {
  const buildDir = appBuildDir(id);
  const filePath = path.resolve(buildDir, relativePath);
  const relative = path.relative(buildDir, filePath);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return { ok: false, reason: 'not_found' };
  }

  const markerPath = path.join(buildDir, 'deployment.json');
  const markerBefore = await readDeploymentMarker(markerPath);
  const allowMissing =
    markerBefore.kind === 'missing' &&
    (await deploymentAllowsMissingMarker(id, expectedDeploymentId));
  if (!markerMatches(markerBefore, expectedDeploymentId, allowMissing)) {
    return { ok: false, reason: 'unavailable' };
  }

  let before: StableFileStat;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    before = await fs.stat(filePath);
    handle = await fs.open(filePath, 'r');
  } catch (error) {
    return {
      ok: false,
      reason: isMissingFileError(error)
        ? await classifyMissingLiveFile(
            filePath,
            markerPath,
            markerBefore,
            expectedDeploymentId,
            allowMissing,
          )
        : 'unavailable',
    };
  }

  try {
    const openedBefore = await handle.stat();
    if (!sameFile(before, openedBefore) || !openedBefore.isFile()) {
      return { ok: false, reason: 'unavailable' };
    }
    const data = await handle.readFile();
    const [openedAfter, pathAfter, markerAfter] = await Promise.all([
      handle.stat(),
      fs.stat(filePath),
      readDeploymentMarker(markerPath),
    ]);
    if (
      !sameFile(openedBefore, openedAfter) ||
      !sameFile(openedBefore, pathAfter) ||
      !sameMarker(markerBefore, markerAfter) ||
      !markerMatches(markerAfter, expectedDeploymentId, allowMissing)
    ) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    await handle.close().catch(() => {});
  }
}
