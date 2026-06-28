/** Server-only: lazy Deno backend process manager + Connect reverse proxy. */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { appBuildDir, appStorageDir } from '~agent/paths';
import { ensureAppDatabase } from './provision';

type RunningBackend = {
  proc: ChildProcess;
  port: number;
  startedAt: number;
  ready: Promise<void>;
  getLog: () => string;
};

type RuntimeGlobal = typeof globalThis & {
  __hatchAppRuntime__?: Map<string, RunningBackend>;
  __hatchAppStarting__?: Map<string, Promise<number>>;
  __hatchAppStopEpoch__?: Map<string, number>;
  __hatchAppKeepAlive__?: Set<string>;
  __hatchAppCleanup__?: boolean;
};

function registry(): Map<string, RunningBackend> {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppRuntime__ ??= new Map<string, RunningBackend>();
  return g.__hatchAppRuntime__;
}

/** In-flight cold starts, so concurrent callers coalesce onto one process. */
function startingRegistry(): Map<string, Promise<number>> {
  const g = globalThis as RuntimeGlobal;
  g.__hatchAppStarting__ ??= new Map<string, Promise<number>>();
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

/**
 * Mark an app's backend as long-running. While marked, the platform restarts
 * it automatically if the process exits unexpectedly.
 */
export function setKeepAlive(id: string, on: boolean): void {
  const set = keepAliveSet();
  if (on) set.add(id);
  else set.delete(id);
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
export async function ensureAppRunning(id: string): Promise<number> {
  const reg = registry();
  const existing = reg.get(id);
  if (existing) {
    if (existing.proc.exitCode === null && !existing.proc.killed) {
      await existing.ready;
      return existing.port;
    }
    reg.delete(id);
  }

  // Coalesce concurrent cold starts. Without this, two requests that both find
  // an empty registry each spawn a backend and the second `reg.set()` orphans
  // the first process so `stopApp()` can never kill it. The first caller records
  // a pending-start promise that later callers await instead of starting again.
  const starting = startingRegistry();
  const pending = starting.get(id);
  if (pending) return pending;

  const startPromise = startBackend(id);
  starting.set(id, startPromise);
  try {
    return await startPromise;
  } finally {
    // Only clear our own entry: a stopApp() during startup deletes this entry
    // and a later ensureAppRunning() may register a fresh one we must not drop.
    if (starting.get(id) === startPromise) starting.delete(id);
  }
}

async function startBackend(id: string): Promise<number> {
  const reg = registry();
  // Snapshot the stop epoch: if stopApp() runs while we're spawning, we abort
  // instead of registering/serving a build the caller has since superseded.
  const epoch = stopEpoch(id);
  const buildDir = appBuildDir(id);
  if (!existsSync(path.join(buildDir, 'backend', 'main.ts'))) {
    throw new Error(`App "${id}" has no built backend. Deploy it first.`);
  }

  const databaseUrl = await ensureAppDatabase(id);
  const port = await freePort();

  const storageDir = appStorageDir(id);
  mkdirSync(storageDir, { recursive: true });

  const proc = spawn(
    'deno',
    [
      'run',
      '--allow-net',
      '--allow-env',
      '--allow-read',
      '--allow-write',
      '--no-prompt',
      'backend/main.ts',
    ],
    {
      cwd: buildDir,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: databaseUrl,
        STORAGE_DIR: storageDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let log = '';
  const appendLog = (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-4000);
  };
  proc.stdout?.on('data', appendLog);
  proc.stderr?.on('data', appendLog);

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
    startedAt: Date.now(),
    ready: Promise.resolve(),
    getLog: () => log,
  };
  backend.ready = waitForPort(port, 20000);
  reg.set(id, backend);
  proc.on('exit', () => {
    if (reg.get(id) === backend) reg.delete(id);
    // Long-running backends self-heal: if still marked keep-alive (i.e. not
    // intentionally stopped), restart after a short backoff.
    if (keepAliveSet().has(id)) {
      setTimeout(() => {
        if (keepAliveSet().has(id) && !registry().has(id)) {
          void ensureAppRunning(id).catch(() => {
            /* will retry on next exit / request */
          });
        }
      }, 1000);
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

  return port;
}

/**
 * Server-initiated call into an app backend (used by the cron scheduler).
 * Lazily starts the backend, then issues a direct HTTP request to `pathAndQuery`.
 */
export async function callAppBackend(
  id: string,
  pathAndQuery: string,
  init?: RequestInit,
): Promise<{ status: number; body: string }> {
  const port = await ensureAppRunning(id);
  const path = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`;
  const upstream = await fetch(`http://127.0.0.1:${port}${path}`, init);
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
 * Stop a running app backend (no-op if not running). Clears the keep-alive
 * mark so long-running backends are not auto-restarted by an intentional stop.
 */
export function stopApp(id: string): void {
  keepAliveSet().delete(id);
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
}

/**
 * Reverse-proxy a platform request to the app's Deno backend.
 * `stripPrefix` is removed from the pathname before forwarding (e.g. the
 * `/api/apps/<id>/rpc` Connect base path).
 */
export async function proxyAppRequest(
  id: string,
  request: Request,
  stripPrefix: string,
  prependPath = '',
): Promise<Response> {
  const port = await ensureAppRunning(id);
  const url = new URL(request.url);
  const stripped = url.pathname.startsWith(stripPrefix)
    ? url.pathname.slice(stripPrefix.length)
    : url.pathname;
  const rest = `${prependPath}${stripped}` || '/';
  const target = `http://127.0.0.1:${port}${rest}${url.search}`;

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('content-length');

  const init: RequestInit = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = new Uint8Array(await request.arrayBuffer());
  }

  const upstream = await fetch(target, init);
  const body = new Uint8Array(await upstream.arrayBuffer());
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

  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
