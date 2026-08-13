/** Server-only: lazy Deno backend process manager + Connect reverse proxy. */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  appBuildDir,
  appStorageDir,
  deploymentArtifactDir,
  deploymentBuildDir,
} from '~agent/paths';
import { HATCH_SDK_IMPORT_MAP } from '~agent/hatch-sdk';
import { db, schema } from '~/db';
import { internalPlatformUrl } from '../internal-platform-url';
import { subprocessSandboxEnv } from '../sandbox-env';
import {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  hatchSignature,
} from '../secrets';
import {
  buildMatchesDeployment,
  readBuildDeploymentMarker,
} from './build-identity';
import { appDatabaseRuntimeEnv } from './runtime-database';
import {
  type BackendRuntimeSnapshot,
  getBackendSnapshot,
  recordBackendAutoRestart,
  recordBackendExit,
  recordBackendReady,
  recordBackendSpawn,
  recordBackendStartFailure,
  recordBackendStopped,
} from './runtime-state';

export type BackendArtifact = {
  /** Validated absolute path to the runtime entry inside artifact/backend/. */
  entryPath: string;
  format?: 'bundle-v1';
};

const LEGACY_BACKEND_ENTRY = 'backend/main.ts';
const NORMALIZED_MANIFEST = 'manifest.normalized.json';

function invalidBackendArtifact(message: string): Error {
  return new Error(`Invalid backend artifact: ${message}`);
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function validateBackendEntryPath(buildDir: string, entry: string): string {
  if (
    entry.length === 0 ||
    entry.includes('\0') ||
    entry.includes('\\') ||
    path.posix.isAbsolute(entry) ||
    entry.split('/').includes('..')
  ) {
    throw invalidBackendArtifact(
      `backend.entry must be a relative path inside "backend/": ${JSON.stringify(entry)}`,
    );
  }

  const normalized = path.posix.normalize(entry);
  if (normalized === 'backend' || !normalized.startsWith('backend/')) {
    throw invalidBackendArtifact(
      `backend.entry must be a relative path inside "backend/": ${JSON.stringify(entry)}`,
    );
  }

  const backendRoot = path.resolve(buildDir, 'backend');
  const absoluteEntry = path.resolve(buildDir, ...normalized.split('/'));
  const relativeToBackend = path.relative(backendRoot, absoluteEntry);
  if (
    relativeToBackend === '' ||
    relativeToBackend === '..' ||
    relativeToBackend.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToBackend)
  ) {
    throw invalidBackendArtifact(
      `backend.entry escapes the artifact backend directory: ${JSON.stringify(entry)}`,
    );
  }

  let cursor = path.resolve(buildDir);
  const segments = normalized.split('/');
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (isMissingPath(error)) {
        throw invalidBackendArtifact(
          `backend.entry does not exist: ${JSON.stringify(normalized)}`,
        );
      }
      throw invalidBackendArtifact(
        `cannot inspect backend.entry ${JSON.stringify(normalized)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw invalidBackendArtifact(
        `backend.entry must not traverse symbolic links: ${JSON.stringify(normalized)}`,
      );
    }
    const finalSegment = index === segments.length - 1;
    if (!finalSegment && !stat.isDirectory()) {
      throw invalidBackendArtifact(
        `backend.entry parent is not a directory: ${JSON.stringify(normalized)}`,
      );
    }
    if (finalSegment && !stat.isFile()) {
      throw invalidBackendArtifact(
        `backend.entry is not a regular file: ${JSON.stringify(normalized)}`,
      );
    }
  }

  return absoluteEntry;
}

function readBackendArtifactMetadata(buildDir: string): {
  entry: string;
  format?: 'bundle-v1';
} {
  const manifestPath = path.join(buildDir, NORMALIZED_MANIFEST);
  let manifestStat;
  try {
    manifestStat = lstatSync(manifestPath);
  } catch (error) {
    if (isMissingPath(error)) {
      throw invalidBackendArtifact(`${NORMALIZED_MANIFEST} does not exist`);
    }
    throw invalidBackendArtifact(
      `cannot inspect ${NORMALIZED_MANIFEST}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw invalidBackendArtifact(
      `${NORMALIZED_MANIFEST} must be a regular file and not a symbolic link`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw invalidBackendArtifact(
      `${NORMALIZED_MANIFEST} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidBackendArtifact(
      `${NORMALIZED_MANIFEST} must contain an object`,
    );
  }

  const manifest = parsed as Record<string, unknown>;
  if (!Object.hasOwn(manifest, 'backend')) {
    return { entry: LEGACY_BACKEND_ENTRY };
  }
  const backend = manifest.backend;
  if (!backend || typeof backend !== 'object' || Array.isArray(backend)) {
    throw invalidBackendArtifact('backend metadata must be an object');
  }

  const metadata = backend as Record<string, unknown>;
  if (typeof metadata.entry !== 'string' || metadata.entry.length === 0) {
    throw invalidBackendArtifact('backend.entry must be a non-empty string');
  }
  const entry = metadata.entry;

  if (!Object.hasOwn(metadata, 'format')) return { entry };
  if (metadata.format !== 'bundle-v1') {
    throw invalidBackendArtifact(
      `unsupported backend format: ${JSON.stringify(metadata.format)}`,
    );
  }
  return { entry, format: 'bundle-v1' };
}

export function backendArtifactEnv(
  buildDir: string,
  artifact: BackendArtifact,
): Record<string, string> {
  if (artifact.format !== 'bundle-v1') return {};
  return {
    HATCH_ASSETS_DIR: path.resolve(buildDir, 'backend', 'assets'),
  };
}

/** Expose persistent storage only when the capability selected a directory. */
export function backendStorageEnv(
  storageDir: string | null,
): Record<string, string> {
  return storageDir ? { STORAGE_DIR: storageDir } : {};
}

/**
 * Resolve the backend artifact recorded in the staged normalized manifest.
 * Falls back to the scaffold convention (`backend/main.ts`) for older
 * artifacts whose manifest predates the recorded `backend.entry`.
 */
export function resolveBackendArtifact(buildDir: string): BackendArtifact {
  const metadata = readBackendArtifactMetadata(buildDir);
  const entryPath = validateBackendEntryPath(buildDir, metadata.entry);
  return metadata.format === 'bundle-v1'
    ? { entryPath, format: 'bundle-v1' }
    : { entryPath };
}

/** Outbound workflow calls the app declared, read from the staged manifest. */
function readWorkflowRefs(
  buildDir: string,
): { alias: string; workflow: string }[] {
  try {
    const raw = readFileSync(
      path.join(buildDir, 'manifest.normalized.json'),
      'utf8',
    );
    const refs = (JSON.parse(raw) as { workflows?: unknown }).workflows;
    if (!Array.isArray(refs)) return [];
    return refs.filter(
      (r): r is { alias: string; workflow: string } =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as { alias?: unknown }).alias === 'string' &&
        typeof (r as { workflow?: unknown }).workflow === 'string',
    );
  } catch {
    return [];
  }
}

/** Prefer immutable deployment bytes; fall back only for legacy artifacts. */
function runtimeBuildDir(id: string, deploymentId: string): string {
  const artifact = deploymentArtifactDir(id, deploymentId);
  if (existsSync(artifact)) return artifact;
  const legacy = deploymentBuildDir(id, deploymentId);
  if (existsSync(legacy)) return legacy;
  return appBuildDir(id);
}

/**
 * Build the `HATCH_WORKFLOWS` env value: a JSON map of alias →
 * `{ workflow, name, url, secret }` so the backend can invoke each declared
 * workflow through the platform's external workflow API. The secret lives only
 * in this injected env (never in the normalized manifest shipped to the
 * browser). Returns null when the app declares no callable workflows.
 */
async function buildWorkflowsEnv(buildDir: string): Promise<string | null> {
  const refs = readWorkflowRefs(buildDir);
  if (refs.length === 0) return null;
  const { getCallableWorkflow } = await import('../workflows/external');
  const map: Record<
    string,
    { workflow: string; name: string; url: string; secret: string }
  > = {};
  for (const ref of refs) {
    const callable = await getCallableWorkflow(ref.workflow);
    // Skip workflows that became un-callable since deploy (e.g. webhook
    // disabled); the app handles a missing alias the same as any other error.
    if (!callable) continue;
    map[ref.alias] = {
      workflow: callable.id,
      name: callable.name,
      url: internalPlatformUrl(callable.path),
      secret: callable.secret,
    };
  }
  return Object.keys(map).length > 0 ? JSON.stringify(map) : null;
}

/**
 * Resolve Deno's module cache directory (`DENO_DIR` or the platform default).
 * Legacy source artifacts load npm/jsr deps from here at runtime, and some
 * packages read their own cached files, so that compatibility path needs access.
 */
function denoCacheDir(): string | null {
  if (process.env.DENO_DIR) return process.env.DENO_DIR;
  const home = os.homedir();
  if (!home) return null;
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'deno');
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    return local ? path.join(local, 'deno') : null;
  }
  const xdgCache = process.env.XDG_CACHE_HOME ?? path.join(home, '.cache');
  return path.join(xdgCache, 'deno');
}

type BackendDenoArgsOptions = {
  artifact: BackendArtifact;
  buildDir: string;
  storageDir: string | null;
  cacheDir: string | null;
  certPaths: readonly string[];
  importMap?: string | null;
  hasLock: boolean;
};

/** Build the sandboxed Deno invocation for a staged backend artifact. */
export function buildBackendDenoArgs({
  artifact,
  buildDir,
  storageDir,
  cacheDir,
  certPaths,
  importMap,
  hasLock,
}: BackendDenoArgsOptions): string[] {
  const bundled = artifact.format === 'bundle-v1';
  const allowRead = bundled
    ? [path.resolve(buildDir, 'backend', 'assets')]
    : [buildDir];
  if (storageDir) allowRead.push(storageDir);
  if (!bundled && cacheDir) allowRead.push(cacheDir);
  allowRead.push(...certPaths);

  const denoArgs = ['run'];
  if (bundled) {
    denoArgs.push(
      '--no-config',
      '--no-lock',
      '--no-npm',
      '--no-remote',
      '--cached-only',
    );
  } else {
    // Legacy source artifacts resolve dependencies from the build-time cache.
    denoArgs.push('--node-modules-dir=none');
  }
  denoArgs.push(`--allow-read=${allowRead.join(',')}`);
  if (storageDir) denoArgs.push(`--allow-write=${storageDir}`);
  denoArgs.push('--allow-net', '--allow-env', '--no-prompt');
  if (!bundled && importMap) {
    denoArgs.push(`--import-map=${importMap}`);
  }
  if (!bundled && hasLock) {
    denoArgs.push('--lock=deno.lock', '--frozen');
  }
  denoArgs.push(artifact.entryPath);
  return denoArgs;
}

type RunningBackend = {
  proc: ChildProcess;
  port: number;
  deploymentId: string;
  startedAt: number;
  ready: Promise<void>;
  getLog: () => string;
};

type StartingBackend = {
  deploymentId: string | undefined;
  promise: Promise<number>;
};

type RuntimeGlobal = typeof globalThis & {
  __hatchAppRuntime__?: Map<string, RunningBackend>;
  __hatchAppStarting__?: Map<string, StartingBackend>;
  __hatchAppStopEpoch__?: Map<string, number>;
  __hatchAppKeepAlive__?: Set<string>;
  __hatchAppRestarts__?: Map<string, number>;
  __hatchAppCleanup__?: boolean;
};

function registry(): Map<string, RunningBackend> {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppRuntime__ ??= new Map<string, RunningBackend>();
  return g.__hatchAppRuntime__;
}

/** In-flight cold starts, so concurrent callers coalesce onto one process. */
function startingRegistry(): Map<string, StartingBackend> {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppStarting__ ??= new Map<string, StartingBackend>();
  return g.__hatchAppStarting__;
}

/**
 * Monotonic per-app counter bumped by {@link stopApp}. A cold start captures the
 * epoch when it begins and refuses to register (and kills) its process if the
 * epoch changed meanwhile — i.e. a stop/redeploy happened during startup — so a
 * stale build is never left serving or orphaned.
 */
function stopEpoch(id: string): number {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppStopEpoch__ ??= new Map<string, number>();
  return g.__hatchAppStopEpoch__.get(id) ?? 0;
}

function bumpStopEpoch(id: string): void {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppStopEpoch__ ??= new Map<string, number>();
  g.__hatchAppStopEpoch__.set(id, (g.__hatchAppStopEpoch__.get(id) ?? 0) + 1);
}

function keepAliveSet(): Set<string> {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppKeepAlive__ ??= new Set<string>();
  return g.__hatchAppKeepAlive__;
}

/** Consecutive fast-crash count per app, driving the restart backoff. */
function restartCounts(): Map<string, number> {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppRestarts__ ??= new Map<string, number>();
  return g.__hatchAppRestarts__;
}

/** A process that stayed up this long is considered healthy: backoff resets. */
const RESTART_HEALTHY_UPTIME_MS = 30_000;
const RESTART_BASE_DELAY_MS = 1000;
const RESTART_MAX_DELAY_MS = 60_000;

/**
 * Persist a backend lifecycle event to the `logs` table so a crash leaves a
 * durable trace (the in-memory log ring dies with the process). Best-effort.
 */
async function recordBackendLog(
  id: string,
  level: 'info' | 'error',
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(schema.logs).values({
      appId: id,
      source: 'backend',
      level,
      message,
      data: (data ?? null) as never,
    });
  } catch {
    /* logging is best-effort */
  }
}

/**
 * Mark an app's backend as long-running. While marked, the platform restarts
 * it automatically if the process exits unexpectedly.
 */
export function setKeepAlive(id: string, on: boolean): void {
  const set = keepAliveSet();
  if (on) set.add(id);
  else set.delete(id);
}

/**
 * Boot every deployed long-running backend and re-arm its keep-alive mark.
 * The keep-alive registry is in-memory, so after a server restart these
 * backends would otherwise stay down (and stop self-healing) until the first
 * request happens to hit them. Called once at server startup; each app's boot
 * is independent and best-effort.
 */
export async function warmLongRunningBackends(): Promise<void> {
  const apps = await db.query.apps.findMany({
    where: (s, { eq }) => eq(s.status, 'deployed'),
    columns: {
      id: true,
      backendMode: true,
      capabilities: true,
      currentDeploymentId: true,
    },
  });
  for (const app of apps) {
    if (
      app.backendMode !== 'long-running' ||
      !app.capabilities?.backend ||
      !app.currentDeploymentId
    ) {
      continue;
    }
    setKeepAlive(app.id, true);
    void ensureAppRunning(app.id, app.currentDeploymentId).catch((error) => {
      console.error(
        `[runtime] warm start of long-running backend "${app.id}" failed:`,
        error instanceof Error ? error.message : error,
      );
    });
  }
}

function installCleanup(): void {
  const g = globalThis as RuntimeGlobal;
  if (g.__hatchAppCleanup__) return;
  g.__hatchAppCleanup__ = true;
  const killAll = () => {
    for (const backend of registry().values()) {
      try {
        backend.proc.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
    }
  };
  process.on('exit', killAll);
  process.once('SIGINT', () => {
    killAll();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    killAll();
    process.exit(0);
  });
}

installCleanup();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('could not allocate a port')));
      }
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await delay(150);
  }
  throw new Error(`backend did not become reachable on port ${port}`);
}

/** Start (or reuse) the Deno backend for an app and return its local port. */
export async function ensureAppRunning(
  id: string,
  expectedDeploymentId?: string,
): Promise<number> {
  const reg = registry();
  const existing = reg.get(id);
  if (existing) {
    if (existing.proc.exitCode === null && !existing.proc.killed) {
      if (
        !expectedDeploymentId ||
        existing.deploymentId === expectedDeploymentId
      ) {
        await existing.ready;
        return existing.port;
      }
      // Another platform process activated a deployment after this backend was
      // spawned. Preserve keep-alive intent while invalidating only the stale
      // local process; the replacement below boots the expected artifact.
      invalidateLocalBackend(id, true);
    } else {
      reg.delete(id);
    }
  }

  // Coalesce concurrent cold starts. Without this, two requests that both find
  // an empty registry each spawn a backend and the second `reg.set()` orphans
  // the first process so `stopApp()` can never kill it. The first caller records
  // a pending-start promise that later callers await instead of starting again.
  const starting = startingRegistry();
  const pending = starting.get(id);
  if (pending) {
    if (
      !expectedDeploymentId ||
      pending.deploymentId === expectedDeploymentId
    ) {
      return pending.promise;
    }
    invalidateLocalBackend(id, true);
  }

  const startPromise = startBackend(id, expectedDeploymentId);
  const start = { deploymentId: expectedDeploymentId, promise: startPromise };
  starting.set(id, start);
  try {
    return await startPromise;
  } finally {
    // Only clear our own entry: a stopApp() during startup deletes this entry
    // and a later ensureAppRunning() may register a fresh one we must not drop.
    if (starting.get(id) === start) starting.delete(id);
  }
}

async function startBackend(
  id: string,
  expectedDeploymentId?: string,
): Promise<number> {
  const reg = registry();
  // Snapshot the stop epoch: if stopApp() runs while we're spawning, we abort
  // instead of registering/serving a build the caller has since superseded.
  const epoch = stopEpoch(id);
  const initialApp = await db.query.apps.findFirst({
    where: (row, { eq }) => eq(row.id, id),
    columns: {
      status: true,
      capabilities: true,
      currentDeploymentId: true,
    },
  });
  if (!initialApp || initialApp.status === 'archived') {
    setKeepAlive(id, false);
    throw new Error(`App "${id}" is not available.`);
  }
  if (!initialApp.capabilities?.backend) {
    setKeepAlive(id, false);
    throw new Error(`App "${id}" has no active backend.`);
  }
  const targetDeploymentId = initialApp.currentDeploymentId;
  if (!targetDeploymentId) {
    throw new Error(`App "${id}" has no active deployment.`);
  }
  if (expectedDeploymentId && targetDeploymentId !== expectedDeploymentId) {
    throw new Error(
      `App "${id}" deployment changed before its backend started. Retry ` +
        'against the active deployment.',
    );
  }
  const buildDir = runtimeBuildDir(id, targetDeploymentId);
  const buildMarker = readBuildDeploymentMarker(buildDir);
  if (buildMarker.kind === 'invalid') {
    throw new Error(
      `App "${id}" build has an invalid deployment marker. Redeploy or ` +
        'restore a valid deployment before starting its backend.',
    );
  }
  if (
    buildMarker.kind === 'deployment' &&
    buildMarker.id !== targetDeploymentId
  ) {
    throw new Error(
      `App "${id}" build belongs to deployment ${buildMarker.id}, not active ` +
        `${targetDeploymentId}. Retry after deployment finalization.`,
    );
  }
  if (
    buildMarker.kind === 'missing' &&
    !(await buildMatchesDeployment(id, targetDeploymentId, buildDir))
  ) {
    throw new Error(
      `App "${id}" build has no deployment marker and is not a verified ` +
        'legacy artifact. Redeploy or restore a valid deployment before ' +
        'starting its backend.',
    );
  }
  let backendArtifact: BackendArtifact;
  try {
    backendArtifact = resolveBackendArtifact(buildDir);
  } catch (error) {
    throw new Error(
      `App "${id}" has an invalid backend artifact. Redeploy or restore a ` +
        `valid deployment before starting it: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }
  // Resolve invocation config (URL + secret) for each declared workflow call so
  // the backend can trigger top-level workflows through the external API.
  const workflowsEnv = await buildWorkflowsEnv(buildDir);

  // Per-app HMAC key so the backend can verify platform-originated requests
  // (cron RPC calls) AND sign its own calls into platform APIs (KV). Absent for
  // apps deployed before this column existed; such backends simply can't verify
  // and the cron call still reaches them.
  const appRow = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
    columns: {
      status: true,
      signingSecret: true,
      capabilities: true,
      currentDeploymentId: true,
    },
  });
  if (!appRow || appRow.status === 'archived') {
    setKeepAlive(id, false);
    throw new Error(`App "${id}" is not available.`);
  }
  if (!appRow.capabilities?.backend) {
    setKeepAlive(id, false);
    throw new Error(`App "${id}" has no active backend.`);
  }
  const activeDeploymentId = appRow.currentDeploymentId ?? null;
  if (!activeDeploymentId) {
    throw new Error(`App "${id}" has no active deployment.`);
  }
  if (
    activeDeploymentId !== targetDeploymentId ||
    (buildMarker.kind === 'deployment' && buildMarker.id !== activeDeploymentId)
  ) {
    throw new Error(
      `App "${id}" deployment changed while its backend was starting. Retry ` +
        'against the active deployment.',
    );
  }
  const backendDeploymentId = targetDeploymentId;
  const signingSecret = appRow.signingSecret ?? null;
  const storageDir = appRow.capabilities.storage ? appStorageDir(id) : null;
  if (storageDir) mkdirSync(storageDir, { recursive: true });
  const databaseEnv = await appDatabaseRuntimeEnv(
    id,
    appRow.capabilities.database,
  );
  const port = await freePort();

  // KV is stored in the platform DB (not reachable from the sandboxed
  // subprocess), so a KV-capable backend talks to it over HTTP at an absolute
  // URL, signing each request with HATCH_SIGNING_SECRET. Inject the endpoint so
  // the app doesn't hardcode the platform origin. Relative URLs have no host
  // inside the subprocess, so use the platform's loopback HTTP endpoint.
  const kvUrl = appRow.capabilities?.kv
    ? internalPlatformUrl(`/api/apps/${id}/kv`)
    : null;
  const dataUrl = appRow.capabilities?.dataTable
    ? internalPlatformUrl(`/api/apps/${id}/data`)
    : null;

  // Bundles may read only their fixed asset directory and, when enabled, the
  // app's persistent storage. Legacy source artifacts retain build/cache access
  // for source imports and dependency resolution. TLS trust stores are included
  // when configured.
  const cacheDir = denoCacheDir();
  const certPaths: string[] = [];
  for (const certVar of [
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    const certPath = process.env[certVar];
    if (certPath) certPaths.push(certPath);
  }

  const denoArgs = buildBackendDenoArgs({
    artifact: backendArtifact,
    buildDir,
    storageDir,
    cacheDir,
    certPaths,
    importMap: existsSync(path.join(buildDir, HATCH_SDK_IMPORT_MAP))
      ? HATCH_SDK_IMPORT_MAP
      : null,
    hasLock: existsSync(path.join(buildDir, 'deno.lock')),
  });

  const proc = spawn('deno', denoArgs, {
    cwd: buildDir,
    // Never inherit the platform's process.env (DATABASE_URL, auth secrets,
    // provider keys); hand over only the sandbox allowlist plus the app's own
    // runtime variables.
    env: subprocessSandboxEnv({
      PORT: String(port),
      ...databaseEnv,
      ...backendStorageEnv(storageDir),
      ...backendArtifactEnv(buildDir, backendArtifact),
      ...(workflowsEnv ? { HATCH_WORKFLOWS: workflowsEnv } : {}),
      ...(signingSecret ? { HATCH_SIGNING_SECRET: signingSecret } : {}),
      ...(kvUrl ? { HATCH_KV_URL: kvUrl } : {}),
      ...(dataUrl ? { HATCH_DATA_URL: dataUrl } : {}),
      HATCH_DEPLOYMENT_ID: backendDeploymentId,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  const appendLog = (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-4000);
  };
  proc.stdout?.on('data', appendLog);
  proc.stderr?.on('data', appendLog);

  // A ChildProcess 'error' with no listener is an uncaught exception that
  // would crash the whole server (e.g. deno missing from PATH). Capture it —
  // and an exit that happens before the port ever opens — as a fast readiness
  // failure instead of burning the full 20s port-wait.
  const spawnFailure = new Promise<never>((_, reject) => {
    proc.once('error', (err) => {
      reject(new Error(`backend process failed to start: ${err.message}`));
    });
    proc.once('exit', (code, signal) => {
      reject(
        new Error(
          `backend process exited before becoming ready (${signal ?? code})`,
        ),
      );
    });
  });
  // Pre-attach a no-op handler: the rejection also fires when nothing is
  // racing against it (a normal stop after ready, or the epoch-superseded
  // kill below) and must not surface as an unhandled rejection.
  spawnFailure.catch(() => {});

  // A stop/redeploy landed while we were awaiting db/port allocation: abort
  // before registering this now-stale process (which a concurrent warm start
  // could otherwise pick up and serve). This check runs *before* we create
  // `backend.ready` on purpose — creating the readiness promise and then
  // throwing would leave it rejected-but-unawaited (~20s later), an unhandled
  // rejection that can crash the server. Kill the process; the caller boots the
  // current build instead.
  if (stopEpoch(id) !== epoch) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
    throw new Error(`App "${id}" start was superseded by a stop/redeploy.`);
  }

  const backend: RunningBackend = {
    proc,
    port,
    deploymentId: backendDeploymentId,
    startedAt: Date.now(),
    ready: Promise.resolve(),
    getLog: () => log,
  };
  backend.ready = Promise.race([waitForPort(port, 20000), spawnFailure]);
  reg.set(id, backend);
  recordBackendSpawn(id, {
    pid: proc.pid ?? null,
    port,
    startedAt: backend.startedAt,
  });
  proc.on('exit', (code, signal) => {
    recordBackendExit(id, { pid: proc.pid ?? null, code, signal });
    if (reg.get(id) === backend) reg.delete(id);
    const uptimeMs = Date.now() - backend.startedAt;
    // Restart only on an *unexpected* exit. An epoch bump means this process
    // was superseded by an explicit stop/restart/redeploy — its exit event
    // often lands after the caller has already re-armed keep-alive for the
    // replacement, which used to schedule a spurious restart, log a phantom
    // crash, and inflate the auto-restart count.
    const willRestart = stopEpoch(id) === epoch && keepAliveSet().has(id);
    // A self-exit (no signal) is always unexpected — backends are servers.
    // Signal kills are usually our own stop/redeploy SIGKILL, so don't log
    // those; a keep-alive crash is logged by the restart branch below.
    if (!willRestart && signal === null && code !== null && code !== 0) {
      void recordBackendLog(id, 'error', `backend exited with code ${code}`, {
        uptimeMs,
        log: log.slice(-2000),
      });
    }
    // Long-running backends self-heal: if still marked keep-alive (i.e. not
    // intentionally stopped), restart with exponential backoff so a build
    // that crashes on boot doesn't hot-loop a restart every second forever.
    if (willRestart) {
      recordBackendAutoRestart(id);
      const counts = restartCounts();
      const attempt =
        uptimeMs >= RESTART_HEALTHY_UPTIME_MS ? 0 : (counts.get(id) ?? 0);
      counts.set(id, attempt + 1);
      const delayMs = Math.min(
        RESTART_BASE_DELAY_MS * 2 ** attempt,
        RESTART_MAX_DELAY_MS,
      );
      void recordBackendLog(
        id,
        'error',
        `long-running backend exited (${signal ?? code}); restarting in ${delayMs}ms`,
        { uptimeMs, attempt: attempt + 1, log: log.slice(-2000) },
      );
      const timer = setTimeout(() => {
        if (keepAliveSet().has(id) && !registry().has(id)) {
          // Resolve the currently active deployment afresh. Another platform
          // process may have deployed while this backend was running.
          void ensureAppRunning(id).catch(() => {
            /* will retry on next exit / request */
          });
        }
      }, delayMs);
      if (typeof timer.unref === 'function') timer.unref();
    } else {
      restartCounts().delete(id);
    }
  });

  try {
    await backend.ready;
  } catch (error) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
    if (reg.get(id) === backend) reg.delete(id);
    const message = error instanceof Error ? error.message : String(error);
    // Only record a *real* boot failure. If the epoch moved, an intentional
    // stop/restart/redeploy killed this start mid-boot — the resulting
    // SIGKILL/timeout rejection is expected, not a crash, and recording it
    // would show a phantom "failed to start" on the Backends page.
    if (stopEpoch(id) === epoch) {
      recordBackendStartFailure(id, proc.pid ?? null, message);
    }
    throw new Error(`Failed to start app "${id}": ${message}\n${log}`);
  }

  // Stop/redeploy landed during the readiness wait: drop this stale backend so
  // the next request boots the current build rather than reusing this one.
  if (stopEpoch(id) !== epoch) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
    if (reg.get(id) === backend) reg.delete(id);
    throw new Error(`App "${id}" start was superseded by a stop/redeploy.`);
  }

  recordBackendReady(id, proc.pid ?? null);
  return port;
}

/**
 * Cap on how long a backend may take to answer a platform-initiated request.
 * Backends are untrusted code; without a bound, one hung handler pins the
 * platform-side request (a cron slot, a proxied client connection) forever.
 * Applied fully to `callAppBackend` (which buffers the body) and to
 * `proxyAppRequest` only until response headers arrive, so long-lived
 * streaming responses keep working.
 */
const BACKEND_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Server-initiated call into an app backend (used by the cron scheduler).
 * Lazily starts the backend, then issues a direct HTTP request to `pathAndQuery`.
 */
export async function callAppBackend(
  id: string,
  pathAndQuery: string,
  init?: RequestInit,
  expectedDeploymentId?: string,
): Promise<{ status: number; body: string }> {
  const port = await ensureAppRunning(id, expectedDeploymentId);
  const path = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`;
  const upstream = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    signal: AbortSignal.timeout(BACKEND_RESPONSE_TIMEOUT_MS),
  });
  const body = await upstream.text();
  return { status: upstream.status, body };
}

/** Whether an app backend process is currently running. */
export function isAppRunning(id: string): boolean {
  const backend = registry().get(id);
  return Boolean(
    backend && backend.proc.exitCode === null && !backend.proc.killed,
  );
}

/**
 * Point-in-time runtime view of one app backend, merging the live process
 * registry (is it running/starting right now?) with the memory-only lifecycle
 * snapshot (when did it last start/stop, how did it exit). Everything here
 * describes the current platform process only — nothing is read from or
 * persisted to the database.
 */
export type BackendRuntimeView = {
  state: 'running' | 'starting' | 'stopped';
  /** pid/port of the live process; null unless `state === 'running'`. */
  pid: number | null;
  port: number | null;
  /** Start of the current run when running, else of the most recent one. */
  startedAt: number | null;
  stoppedAt: number | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastError: string | null;
  restartCount: number;
  /** Whether the platform auto-restarts this backend if it exits. */
  keepAlive: boolean;
};

export function getBackendRuntimeView(id: string): BackendRuntimeView {
  const snap: BackendRuntimeSnapshot | null = getBackendSnapshot(id);
  const backend = registry().get(id);
  const live = Boolean(
    backend && backend.proc.exitCode === null && !backend.proc.killed,
  );
  // Check the in-flight start first: a cold start registers its process
  // before the readiness wait completes, so "in registry" alone would report
  // `running` for a backend that isn't reachable yet.
  const state = startingRegistry().has(id)
    ? 'starting'
    : live
      ? 'running'
      : 'stopped';
  const running = state === 'running';
  return {
    state,
    pid: running ? (backend?.proc.pid ?? null) : null,
    port: running ? (backend?.port ?? null) : null,
    startedAt: running
      ? (backend?.startedAt ?? null)
      : (snap?.startedAt ?? null),
    stoppedAt: snap?.stoppedAt ?? null,
    lastExitCode: snap?.lastExitCode ?? null,
    lastExitSignal: snap?.lastExitSignal ?? null,
    lastError: snap?.lastError ?? null,
    restartCount: snap?.restartCount ?? 0,
    keepAlive: keepAliveSet().has(id),
  };
}

/**
 * Explicitly start an app backend (Backends page). `keepAlive` re-arms the
 * auto-restart mark for long-running apps — set before the boot (matching
 * deploy/warm-start behavior) so a backend that crashes right after becoming
 * ready still self-heals.
 */
export async function startAppBackend(
  id: string,
  opts: { keepAlive: boolean; expectedDeploymentId?: string },
): Promise<void> {
  if (opts.keepAlive) setKeepAlive(id, true);
  await ensureAppRunning(id, opts.expectedDeploymentId);
}

/** Stop-then-start an app backend (Backends page restart action). */
export async function restartAppBackend(
  id: string,
  opts: { keepAlive: boolean; expectedDeploymentId?: string },
): Promise<void> {
  stopApp(id);
  await startAppBackend(id, opts);
}

/**
 * Stop a running app backend (no-op if not running). Clears the keep-alive
 * mark so long-running backends are not auto-restarted by an intentional stop.
 */
export function stopApp(id: string): void {
  invalidateLocalBackend(id, false);
}

function invalidateLocalBackend(id: string, preserveKeepAlive: boolean): void {
  if (!preserveKeepAlive) keepAliveSet().delete(id);
  // Invalidate any in-flight cold start so a subsequent ensureAppRunning() (e.g.
  // the long-running warm start right after a deploy/rollback) boots the current
  // build instead of coalescing onto a start for the build we're replacing.
  bumpStopEpoch(id);
  startingRegistry().delete(id);
  const reg = registry();
  const backend = reg.get(id);
  if (!backend) return;
  try {
    backend.proc.kill('SIGKILL');
  } catch {
    /* best-effort */
  }
  reg.delete(id);
  // The kill's exit event (matching pid) fills in the exit signal moments
  // later; record the stop itself so the moment is never lost.
  recordBackendStopped(id);
}

/**
 * Cap (bytes) on a webhook body the platform buffers in order to HMAC-sign it.
 * Signed webhooks ('platform' auth) must be read fully to compute the signature,
 * so we bound them; the unsigned passthrough path still streams without a limit.
 */
const MAX_SIGNED_BODY_BYTES = 1024 * 1024;

/**
 * Reverse-proxy a platform request to the app's Deno backend.
 * `stripPrefix` is removed from the pathname before forwarding (e.g. the
 * `/api/apps/<id>/rpc` Connect base path).
 *
 * When `signWithSecret` is set the body is buffered and signed with the per-app
 * key (HMAC over `<timestamp>.<body>`), forwarding `x-hatch-timestamp` +
 * `x-hatch-signature` so the backend can verify the platform vetted the call.
 */
export async function proxyAppRequest(
  id: string,
  request: Request,
  stripPrefix: string,
  prependPath = '',
  options: {
    stripSecretParam?: boolean;
    preserveAuthorization?: boolean;
    signWithSecret?: string;
    expectedDeploymentId?: string;
  } = {},
): Promise<Response> {
  const port = await ensureAppRunning(id, options.expectedDeploymentId);
  const url = new URL(request.url);
  const stripped = url.pathname.startsWith(stripPrefix)
    ? url.pathname.slice(stripPrefix.length)
    : url.pathname;
  const rest = `${prependPath}${stripped}` || '/';
  // Only the webhook proxy path strips `?secret=` (the verified shared secret);
  // for the authenticated RPC/app routes `secret` is a legitimate app parameter.
  let search = url.search;
  if (options.stripSecretParam) {
    const params = new URLSearchParams(url.search);
    params.delete('secret');
    const qs = params.toString();
    search = qs ? `?${qs}` : '';
  }
  const target = `http://127.0.0.1:${port}${rest}${search}`;

  const headers = new Headers(request.headers);
  // Strip platform credentials and client-controlled routing/secret headers so a
  // deployed app can neither read the platform's Better Auth session nor the
  // webhook secret, nor spoof forwarding headers. Also drop hop-by-hop headers.
  for (const header of [
    'host',
    'cookie',
    'x-hatch-secret',
    // Platform→backend signature headers. Strip them from inbound requests so
    // a client can never present forged signing headers; the platform re-signs
    // below (signWithSecret) or via the direct callAppBackend path.
    'x-hatch-timestamp',
    'x-hatch-signature',
    'x-hatch-cron',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
    'via',
    'content-length',
  ]) {
    headers.delete(header);
  }
  // On authenticated RPC/app routes `authorization` would carry the platform's
  // credential, so strip it. On the public webhook path it is instead a
  // caller-supplied header the app's `/__webhook` handler may need to validate,
  // so the webhook proxy opts to preserve it.
  if (!options.preserveAuthorization) {
    headers.delete('authorization');
  }

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
  };
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  if (options.signWithSecret) {
    // Signed forward (platform webhook): buffer the (bounded) body so we can
    // HMAC it, then attach the platform signature headers. GET/HEAD sign over an
    // empty payload. Reject oversize bodies rather than buffer unbounded memory.
    // Sign the RAW bytes (not a UTF-8 decode) so binary/non-UTF-8 webhook bodies
    // verify correctly against the exact forwarded bytes.
    let payload = Buffer.alloc(0);
    if (hasBody) {
      // Reject early when Content-Length already declares an oversize body...
      const declared = Number(request.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > MAX_SIGNED_BODY_BYTES) {
        return new Response('Payload too large', { status: 413 });
      }
      // ...but a missing/incorrect Content-Length (e.g. chunked transfer) can't
      // be trusted, so read the stream incrementally and abort the moment the
      // running total exceeds the cap rather than buffering it all first.
      const reader = request.body?.getReader();
      if (reader) {
        const parts: Buffer[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > MAX_SIGNED_BODY_BYTES) {
            await reader.cancel().catch(() => {});
            return new Response('Payload too large', { status: 413 });
          }
          parts.push(Buffer.from(value));
        }
        payload = Buffer.concat(parts, total);
      }
      init.body = payload;
    }
    const timestamp = String(Date.now());
    headers.set(HATCH_TIMESTAMP_HEADER, timestamp);
    headers.set(
      HATCH_SIGNATURE_HEADER,
      hatchSignature(options.signWithSecret, timestamp, payload),
    );
  } else if (hasBody) {
    // Stream the request body straight through rather than buffering the whole
    // upload in memory, so a large body can't exhaust the server process.
    // `duplex: 'half'` is required by undici when the body is a stream.
    init.body = request.body;
    init.duplex = 'half';
  }

  // Bound only the time to response headers: abort if the backend never
  // answers, but clear the timer once headers arrive so streaming bodies
  // (server-streaming RPCs, long downloads) are not cut off mid-flight.
  const headerTimeout = new AbortController();
  const headerTimer = setTimeout(
    () => headerTimeout.abort(new Error('app backend response timed out')),
    BACKEND_RESPONSE_TIMEOUT_MS,
  );
  if (typeof headerTimer.unref === 'function') headerTimer.unref();
  init.signal = headerTimeout.signal;
  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } finally {
    clearTimeout(headerTimer);
  }
  const responseHeaders = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) responseHeaders.set('content-type', contentType);
  for (const key of [
    'grpc-status',
    'grpc-message',
    'connect-protocol-version',
  ]) {
    const value = upstream.headers.get(key);
    if (value) responseHeaders.set(key, value);
  }

  // Stream the upstream response body through as well instead of buffering it.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
