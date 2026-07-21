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
 * The env allowlist does NOT stop a command from reading secret files by path
 * (e.g. `cat <repo>/.env.local`); shell-sandbox.ts closes that gap on macOS
 * with a seatbelt deny-list, and containerized deployments rely on the
 * container boundary.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AGENT_HOME_DIR } from './paths';

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
export function agentShellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (!ALLOWLIST_LOWER.has(key.toLowerCase())) env[key] = undefined;
  }

  const home = AGENT_HOME_DIR;
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
  return env;
}
