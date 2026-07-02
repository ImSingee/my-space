/**
 * Server-only: best-effort filesystem containment for the Agent's run_command.
 *
 * The shell env allowlist (shell-env.ts) strips secrets from the environment
 * and redirects HOME, but a spawned shell can still read arbitrary paths —
 * `cat <repo>/.env.local` or `cat ~/.ssh/id_rsa` would hand a prompt-injected
 * command the platform's own secrets. On macOS we wrap every command in
 * `sandbox-exec` with a deny-list profile covering the platform's env files
 * and the host user's credential directories.
 *
 * This is defense in depth, not a full boundary: it blocks the realistic
 * "read the platform secrets by path" payloads (including via symlinks, which
 * the kernel resolves before the check) but does not confine reads to the
 * workspace. On non-macOS hosts the platform is expected to run inside a
 * container, which is the actual boundary there.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './paths';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Quote a string as a single shell word (POSIX single-quote escaping). */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Escape a path for an SBPL double-quoted string literal. */
function sbplString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** Escape a path for use inside an SBPL regex literal. */
function sbplRegexEscape(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function buildProfile(): string {
  const home = os.homedir();
  const denyLiterals = [
    // Platform + agent credential files at the repo root.
    path.join(REPO_ROOT, '.env'),
    path.join(REPO_ROOT, 'auth.json'),
    path.join(REPO_ROOT, '.npmrc'),
    path.join(REPO_ROOT, '.git-credentials'),
    // Host user credential files.
    path.join(home, '.netrc'),
    path.join(home, '.npmrc'),
    path.join(home, '.pgpass'),
    path.join(home, '.git-credentials'),
  ];
  const denySubpaths = [
    // Agent credential/state dir at the repo root (pi injects keys explicitly).
    path.join(REPO_ROOT, '.pi'),
    // Host user credential/config stores.
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.kube'),
    path.join(home, '.docker'),
    path.join(home, '.config', 'gh'),
    path.join(home, '.config', 'gcloud'),
  ];
  const rules = [
    ...denyLiterals.map((p) => `(literal ${sbplString(p)})`),
    ...denySubpaths.map((p) => `(subpath ${sbplString(p)})`),
    // .env.local, .env.production, ... at the repo root.
    `(regex #"^${sbplRegexEscape(REPO_ROOT)}/\\.env\\..*$")`,
  ];
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read* file-write*\n  ${rules.join('\n  ')})`,
  ].join('\n');
}

/**
 * Whether sandbox-exec is usable here. Probed once: the binary may be absent
 * on future macOS releases, and applying a sandbox fails when the server
 * itself already runs inside one (sandboxes don't nest) — in both cases we
 * fall back to running commands unwrapped rather than breaking the shell.
 */
let sandboxUsable: boolean | null = null;

function canSandbox(): boolean {
  if (process.platform !== 'darwin') return false;
  if (sandboxUsable !== null) return sandboxUsable;
  if (!existsSync(SANDBOX_EXEC)) {
    sandboxUsable = false;
    return false;
  }
  const probe = spawnSync(
    SANDBOX_EXEC,
    ['-p', '(version 1)(allow default)', '/usr/bin/true'],
    { timeout: 5000 },
  );
  sandboxUsable = probe.status === 0;
  return sandboxUsable;
}

let warnedFallback = false;

/**
 * Wrap a shell command so it runs under the deny-list sandbox when available.
 * Returns the command unchanged on non-macOS hosts (container boundary) or
 * when sandbox-exec is unusable. On macOS specifically, an unusable
 * sandbox-exec is unexpected (the deny-list is the boundary there), so warn
 * once so the operator knows commands are running unconfined.
 */
export function wrapShellCommand(command: string): string {
  if (!canSandbox()) {
    if (process.platform === 'darwin' && !warnedFallback) {
      warnedFallback = true;
      console.warn(
        '[shell-sandbox] sandbox-exec is unavailable; run_command is executing ' +
          'without the filesystem deny-list. Secret files are not path-protected.',
      );
    }
    return command;
  }
  return `${SANDBOX_EXEC} -p ${shQuote(buildProfile())} /bin/sh -c ${shQuote(command)}`;
}
