/**
 * Server-only: a minimal, allowlisted shell environment for the Agent's
 * {@link NodeExecutionEnv}.
 *
 * The execution env builds each command's environment as
 * `{ ...process.env, ...shellEnv, ...perCallEnv }`, so handing it an allowlist
 * alone would NOT drop the server's secrets — process.env is always the base.
 * Instead we explicitly set every NON-allowlisted process.env key to
 * `undefined`; Node's `spawn` omits env entries whose value is `undefined`, so
 * the spawned shell only ever sees allowlisted variables.
 *
 * This keeps deployment secrets (DATABASE_URL, SECRET, BETTER_AUTH_SECRET,
 * provider API keys, …) out of every command the model runs — including ones
 * injected via a malicious project file telling the agent to run `env`.
 *
 * The env allowlist does NOT stop a command from reading private files by path
 * (e.g. `cat <repo>/.env.local`); shell-sandbox.ts closes that gap on macOS
 * with a seatbelt deny-list while still allowing this session's work-root
 * `.env`, and containerized deployments rely on the container boundary.
 */

import { mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_HOME_DIR,
  agentHomeDir,
  REPO_ROOT,
  WORKSPACE_ROOT,
} from './paths';

/** Platform-provided CLI shims used by App codegen and Agent instructions. */
export const PLATFORM_NODE_BIN_DIR = path.join(
  REPO_ROOT,
  'node_modules',
  '.bin',
);

/**
 * Variables a dev shell legitimately needs (git / pnpm / deno / node / tools).
 *
 * NOTE: HOME / USERPROFILE / XDG_* / DENO_DIR / PNPM_HOME are deliberately NOT
 * here — they are redirected to a sandbox home below so the model's shell can't
 * read the server user's real home directory (credentials, ssh keys, …).
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
  // Locating binaries + shells, and basic identity.
  'PATH',
  'SHELL',
  'TERM',
  'USER',
  'LOGNAME',
  // Temp dirs.
  'TMPDIR',
  'TMP',
  'TEMP',
  // Locale / text handling.
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Toolchain niceties that don't point at the host home.
  'DENO_INSTALL_ROOT',
  'COREPACK_HOME',
  // TLS trust so network tooling behaves like the host.
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Windows essentials (harmless no-ops on POSIX).
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
]);

// Env var names are case-insensitive on Windows (Node often exposes the search
// path as `Path`, not `PATH`), so match the allowlist case-insensitively to
// avoid dropping it — which would leave run_command children with no PATH.
const ALLOWLIST_LOWER: ReadonlySet<string> = new Set(
  [...ALLOWLIST].map((key) => key.toLowerCase()),
);

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function inheritedPath(): string {
  const entry = Object.entries(process.env).find(
    ([key]) => key.toLowerCase() === 'path',
  );
  return entry?.[1] ?? '';
}

/**
 * Preserve the runner's toolchain PATH while excluding every Agent-writable
 * workspace directory (and relative entries such as `node_modules/.bin`).
 * The repository's installed CLI shims always win, which keeps manual
 * `buf generate` aligned with platform preparation in production images.
 */
export function agentTrustedPath(): string {
  let canonicalWorkspaceRoot = WORKSPACE_ROOT;
  try {
    canonicalWorkspaceRoot = realpathSync(WORKSPACE_ROOT);
  } catch {
    // The data root may not exist yet on first startup.
  }
  let platformBin: string | null = null;
  try {
    const resolved = realpathSync(PLATFORM_NODE_BIN_DIR);
    if (statSync(resolved).isDirectory()) platformBin = resolved;
  } catch {
    // A dependency install may not have populated the platform CLI bin yet.
  }
  const entries = [
    PLATFORM_NODE_BIN_DIR,
    ...inheritedPath().split(path.delimiter),
  ];
  const seen = new Set<string>();
  return entries
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry))
    .map((entry) => {
      try {
        const resolved = realpathSync(entry);
        return statSync(resolved).isDirectory() ? resolved : null;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is string => entry !== null)
    .filter(
      (entry) =>
        entry === platformBin || !isInside(canonicalWorkspaceRoot, entry),
    )
    .filter((entry) => {
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .join(path.delimiter);
}

/**
 * Build the `shellEnv` for NodeExecutionEnv:
 * 1. neutralize every non-allowlisted server variable (set to `undefined`) so
 *    the merged child environment is effectively an allowlist, then
 * 2. redirect HOME and the toolchain cache/config dirs to a sandbox directory so
 *    the model's shell can neither read the host user's home (~/.npmrc, ~/.ssh,
 *    ~/.aws, …) nor write into it.
 *
 * Allowlisted keys keep their original casing (left untouched in process.env).
 */
export function agentShellEnv(sessionId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (!ALLOWLIST_LOWER.has(key.toLowerCase())) env[key] = undefined;
    // Normalize PATH casing and replace it with the trusted value below.
    if (key.toLowerCase() === 'path') env[key] = undefined;
  }

  // Production Agent turns always provide a session id. The fallback is kept
  // for isolated preparation tests over non-Agent temporary roots.
  const home = sessionId ? agentHomeDir(sessionId) : path.join(AGENT_HOME_DIR);
  mkdirSync(home, { recursive: true });
  // Point home + caches at the sandbox (these override the host values that
  // were just neutralized). Tools create the subdirs lazily on first use.
  env.HOME = home;
  env.USERPROFILE = home; // Windows
  env.XDG_CACHE_HOME = path.join(home, '.cache');
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  env.DENO_DIR = path.join(home, '.cache', 'deno');
  env.PNPM_HOME = path.join(home, '.local', 'share', 'pnpm');
  env.PATH = agentTrustedPath();
  return env;
}
