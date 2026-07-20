/**
 * Best-effort containment for agent-controlled subprocesses (the run_command
 * shell and the runner's worktree git commands).
 *
 * The shell env allowlist (shell-env.ts) strips secrets from the child
 * environment and redirects HOME, but that alone leaves two gaps:
 *
 * - macOS (local dev): a spawned shell can still read arbitrary paths —
 *   `cat <repo>/.env.local` or `cat ~/.ssh/id_rsa` would hand a
 *   prompt-injected command the platform's own secrets. We wrap every command
 *   in `sandbox-exec` with a deny-list profile covering the platform's env
 *   files and the host user's credential directories.
 *
 * - Linux (the Agent Runner container): children inherit the runner's UID by
 *   default, so even with a stripped environment they could read the runner
 *   process's own environment — including AGENT_RUNNER_TOKEN — from
 *   `/proc/<runner-pid>/environ` and impersonate the runner against the
 *   platform's internal API. We run every agent-controlled subprocess as a
 *   dedicated unprivileged user (`hatch-sandbox`, created in the Dockerfile)
 *   via `setpriv`, which makes the runner's /proc entries unreadable to them.
 *   Worktree git commands are demoted too: the agent can write `.git/config`
 *   (core.fsmonitor, filters, hooks…), which would otherwise execute code at
 *   the runner's UID the next time the runner itself runs git there.
 *
 * This is defense in depth, not a full boundary: macOS blocks the realistic
 * "read the platform secrets by path" payloads; Linux relies on the container
 * for filesystem scope while the UID split protects the runner's credentials.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentRunnerEnv } from '../env';
import { AGENT_HOME_DIR, AGENTS_DIR, REPO_ROOT } from './paths';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const SETPRIV = '/usr/bin/setpriv';
/** Unprivileged user agent subprocesses are demoted to (see Dockerfile). */
export const SANDBOX_USER = 'hatch-sandbox';

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
 * setpriv argv that drops to the sandbox user with no supplementary groups
 * and no way to re-gain privileges, then execs `argv`.
 */
function setprivArgv(argv: string[]): string[] {
  return [
    `--reuid=${SANDBOX_USER}`,
    `--regid=${SANDBOX_USER}`,
    '--clear-groups',
    '--no-new-privs',
    '--',
    ...argv,
  ];
}

/**
 * Whether sandbox-exec is usable here. Probed once: the binary may be absent
 * on future macOS releases, and applying a sandbox fails when the server
 * itself already runs inside one (sandboxes don't nest) — in both cases we
 * fall back to running commands unwrapped rather than breaking the shell.
 */
let seatbeltUsable: boolean | null = null;

function canSeatbelt(): boolean {
  if (process.platform !== 'darwin') return false;
  if (seatbeltUsable !== null) return seatbeltUsable;
  if (!existsSync(SANDBOX_EXEC)) {
    seatbeltUsable = false;
    return false;
  }
  const probe = spawnSync(
    SANDBOX_EXEC,
    ['-p', '(version 1)(allow default)', '/usr/bin/true'],
    { timeout: 5000 },
  );
  seatbeltUsable = probe.status === 0;
  return seatbeltUsable;
}

/**
 * Whether the Linux UID sandbox is usable: needs root (setpriv must be able
 * to change uid/gid) and the sandbox user to exist. Both hold inside the
 * runner container; probed once with a real demoted no-op.
 */
let setprivUsable: boolean | null = null;

function canSetpriv(): boolean {
  if (process.platform !== 'linux') return false;
  if (setprivUsable !== null) return setprivUsable;
  if (process.getuid?.() !== 0 || !existsSync(SETPRIV)) {
    setprivUsable = false;
    return false;
  }
  const probe = spawnSync(SETPRIV, setprivArgv(['/bin/true']), {
    timeout: 5000,
  });
  setprivUsable = probe.status === 0;
  return setprivUsable;
}

let warnedFallback = false;

function warnUnconfined(reason: string): void {
  if (warnedFallback) return;
  warnedFallback = true;
  console.warn(`[shell-sandbox] ${reason}`);
}

const LINUX_FALLBACK_WARNING =
  `UID sandboxing is unavailable (needs root, ${SETPRIV} and a ` +
  `"${SANDBOX_USER}" user); agent subprocesses share the runner's UID and ` +
  'can read its environment — including AGENT_RUNNER_TOKEN — via /proc.';

/**
 * Wrap a shell command so it runs under the platform's containment when
 * available: the seatbelt deny-list on macOS, UID demotion on Linux.
 * Falls back to the unwrapped command elsewhere, warning once.
 */
export function wrapShellCommand(command: string): string {
  if (process.platform === 'darwin') {
    if (!canSeatbelt()) {
      warnUnconfined(
        'sandbox-exec is unavailable; run_command is executing without the ' +
          'filesystem deny-list. Secret files are not path-protected.',
      );
      return command;
    }
    return `${SANDBOX_EXEC} -p ${shQuote(buildProfile())} /bin/sh -c ${shQuote(command)}`;
  }
  if (process.platform === 'linux') {
    if (!canSetpriv()) {
      warnUnconfined(LINUX_FALLBACK_WARNING);
      return command;
    }
    const shell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    const argv = setprivArgv([shell, '-c', command]);
    return `${SETPRIV} ${argv.map(shQuote).join(' ')}`;
  }
  return command;
}

export type SandboxedSpawn = { command: string; args: string[] };

/**
 * Wrap a raw argv (no shell involved) with the platform's Agent containment:
 * the macOS seatbelt deny-list or the Linux sandbox uid. Used for runner
 * subprocesses that operate on Agent-controlled files and therefore must not
 * execute with broader filesystem privileges than the Agent itself.
 */
export function sandboxSpawn(argv: [string, ...string[]]): SandboxedSpawn {
  if (process.platform === 'darwin' && canSeatbelt()) {
    return { command: SANDBOX_EXEC, args: ['-p', buildProfile(), ...argv] };
  }
  if (!canSetpriv()) {
    const [command, ...args] = argv;
    return { command, args };
  }
  return { command: SETPRIV, args: setprivArgv(argv) };
}

/**
 * Prepare the Agent Runner process for UID-sandboxed children. Call once at
 * runner startup, before any run executes:
 *
 * - umask 0: worktree files the runner (root) writes — scaffolds, bundles,
 *   write_file output — stay writable for the demoted shell and git, and
 *   vice versa. Scoped to the runner, whose writes all land in the agent
 *   workspace.
 * - chown existing agent dirs: worktrees created by earlier runner versions
 *   are root-owned, which demoted git rejects ("dubious ownership").
 *
 * In production, refuses to start without the sandbox (set
 * HATCH_ALLOW_UNSANDBOXED=true to accept token exposure explicitly).
 */
export function initializeAgentSandbox(): void {
  if (process.platform === 'darwin') return; // seatbelt needs no setup
  if (!canSetpriv()) {
    const { production, allowUnsandboxed } = getAgentRunnerEnv();
    if (production && !allowUnsandboxed) {
      throw new Error(
        `[shell-sandbox] ${LINUX_FALLBACK_WARNING} Refusing to start in ` +
          'production; set HATCH_ALLOW_UNSANDBOXED=true to accept this risk.',
      );
    }
    warnUnconfined(LINUX_FALLBACK_WARNING);
    return;
  }
  process.umask(0);
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(AGENT_HOME_DIR, { recursive: true });
  const chown = spawnSync(
    'chown',
    ['-R', `${SANDBOX_USER}:${SANDBOX_USER}`, AGENTS_DIR, AGENT_HOME_DIR],
    { stdio: 'ignore' },
  );
  if (chown.status !== 0) {
    console.warn(
      `[shell-sandbox] chown of agent dirs failed (exit ${chown.status})`,
    );
  }
  console.log(
    `[shell-sandbox] agent subprocesses run as "${SANDBOX_USER}" (setpriv)`,
  );
}
