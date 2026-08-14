/** Per-session containment for Agent-controlled subprocesses and files. */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentRunnerEnv } from '../env';
import {
  AGENT_HOME_DIR,
  AGENT_IDENTITIES_LOCK_PATH,
  AGENT_IDENTITIES_PATH,
  AGENT_LEGACY_HOME_DIR,
  AGENTS_DIR,
  HATCH_SDK_STAGING_DIR,
  REPO_ROOT,
  WORKSPACE_ROOT,
  agentHomeDir,
  agentSessionDir,
  agentWorkDir,
  isSafePathSegment,
} from './paths';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const SETPRIV = '/usr/bin/setpriv';
const FLOCK = '/usr/bin/flock';
/** Compatibility-only identity used by the setpriv availability probe. */
export const SANDBOX_USER = 'hatch-sandbox';
// Stay inside the conventional 65,536-id rootless-container mapping while
// avoiding the image's system users. Mapping entries are intentionally never
// reused, so one workspace supports 50,001 session identities over its life.
const FIRST_SESSION_UID = 10_000;
const LAST_SESSION_UID = 60_000;
const IDENTITY_FILE_VERSION = 1;
const identityCache = new Map<string, AgentSandboxIdentity>();
const IDENTITY_LOCK_TIMEOUT_MS = 10_000;

export type AgentSandboxIdentity = { uid: number; gid: number };

type IdentityFile = {
  version: typeof IDENTITY_FILE_VERSION;
  nextUid: number;
  sessions: Record<string, AgentSandboxIdentity>;
};

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

function pathSpellings(value: string): string[] {
  const lexical = path.resolve(value);
  try {
    return [...new Set([lexical, realpathSync.native(lexical)])];
  } catch {
    return [lexical];
  }
}

function sbplAnySubpaths(roots: readonly string[]): string {
  return roots.length === 1
    ? `(subpath ${sbplString(roots[0])})`
    : `(require-any ${roots
        .map((value) => `(subpath ${sbplString(value)})`)
        .join(' ')})`;
}

function sbplDenyExcept(
  operation: string,
  root: string,
  exemptions: readonly string[],
): string {
  const contained = exemptions.filter((value) => {
    const relative = path.relative(root, value);
    return (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    );
  });
  return contained.length === 0
    ? `(deny ${operation} (subpath ${sbplString(root)}))`
    : `(deny ${operation} (require-all ` +
        `(subpath ${sbplString(root)}) ` +
        `(require-not ${sbplAnySubpaths(contained)})))`;
}

function buildProfile(sessionId?: string): string {
  const hostHome = os.homedir();
  const denyLiterals = [
    path.join(REPO_ROOT, '.env'),
    path.join(REPO_ROOT, 'auth.json'),
    path.join(REPO_ROOT, '.npmrc'),
    path.join(REPO_ROOT, '.git-credentials'),
    path.join(hostHome, '.netrc'),
    path.join(hostHome, '.npmrc'),
    path.join(hostHome, '.pgpass'),
    path.join(hostHome, '.git-credentials'),
    AGENT_IDENTITIES_PATH,
  ];
  const denySubpaths = [
    path.join(REPO_ROOT, '.pi'),
    // Root-owned SDK generations before their sandbox-UID worktree install.
    HATCH_SDK_STAGING_DIR,
    path.join(hostHome, '.ssh'),
    path.join(hostHome, '.aws'),
    path.join(hostHome, '.gnupg'),
    path.join(hostHome, '.kube'),
    path.join(hostHome, '.docker'),
    path.join(hostHome, '.config', 'gh'),
    path.join(hostHome, '.config', 'gcloud'),
  ];
  const protectedRules = [
    ...denyLiterals.flatMap((entry) =>
      pathSpellings(entry).map((value) => `(literal ${sbplString(value)})`),
    ),
    ...denySubpaths.flatMap((entry) =>
      pathSpellings(entry).map((value) => `(subpath ${sbplString(value)})`),
    ),
    `(regex #"^${sbplRegexEscape(REPO_ROOT)}/\\.env\\..*$")`,
  ];

  const rules = [
    `(deny file-read* file-write*\n  ${protectedRules.join('\n  ')})`,
  ];
  if (sessionId) {
    const session = agentSessionDir(sessionId);
    const work = agentWorkDir(sessionId);
    const home = agentHomeDir(sessionId);
    const allAgentRoots = [
      ...pathSpellings(AGENTS_DIR),
      ...pathSpellings(AGENT_HOME_DIR),
      ...pathSpellings(AGENT_LEGACY_HOME_DIR),
    ];
    const readable = [...pathSpellings(session), ...pathSpellings(home)];
    const writable = [...pathSpellings(work), ...pathSpellings(home)];
    rules.push(
      ...allAgentRoots.map((root) =>
        sbplDenyExcept('file-read*', root, readable),
      ),
      ...allAgentRoots.map((root) =>
        sbplDenyExcept('file-write*', root, writable),
      ),
      // Path canonicalization (not directory listing or file contents) must
      // be able to traverse the two root-owned namespace directories.
      `(allow file-read-metadata\n  ${allAgentRoots
        .map((value) => `(literal ${sbplString(value)})`)
        .join('\n  ')})`,
      `(allow file-read*\n  ${readable
        .map((value) => `(subpath ${sbplString(value)})`)
        .join('\n  ')})`,
      `(allow file-read* file-write*\n  ${writable
        .map((value) => `(subpath ${sbplString(value)})`)
        .join('\n  ')})`,
      // Renaming/deleting `work` itself requires mutating the protected
      // session root. Keep an explicit literal denial as defense in depth.
      `(deny file-write-unlink\n  ${pathSpellings(work)
        .map((value) => `(literal ${sbplString(value)})`)
        .join('\n  ')})`,
    );
  }
  return ['(version 1)', '(allow default)', ...rules].join('\n');
}

/**
 * A narrower profile for the fixed filesystem helper. Unlike run_command's
 * deny-list profile, this blocks data access across user-writable host roots
 * and then grants back only this session's workdir and explicit read roots.
 */
function buildFileProfile(
  sessionId: string,
  readOnlyRoots: readonly string[],
): string {
  const work = agentWorkDir(sessionId);
  const nodeDirectory = path.dirname(process.execPath);
  const protectedRoots = [
    os.homedir(),
    '/Volumes',
    '/private/tmp',
    '/private/var/folders',
    AGENTS_DIR,
    AGENT_HOME_DIR,
    AGENT_LEGACY_HOME_DIR,
  ].flatMap(pathSpellings);
  const readable = [work, nodeDirectory, ...readOnlyRoots].flatMap(
    pathSpellings,
  );
  const writable = pathSpellings(work);
  return [
    '(version 1)',
    '(allow default)',
    ...protectedRoots.map((root) =>
      sbplDenyExcept('file-read-data', root, readable),
    ),
    ...protectedRoots.map((root) =>
      sbplDenyExcept('file-write*', root, writable),
    ),
    // Keep platform credentials denied even if a configured read root is too
    // broad. The helper never needs them.
    `(deny file-read-data file-write*\n  ${[
      path.join(REPO_ROOT, '.env'),
      path.join(REPO_ROOT, 'auth.json'),
      path.join(REPO_ROOT, '.npmrc'),
      path.join(REPO_ROOT, '.git-credentials'),
      AGENT_IDENTITIES_PATH,
    ]
      .flatMap(pathSpellings)
      .map((value) => `(literal ${sbplString(value)})`)
      .join('\n  ')})`,
  ].join('\n');
}

function setprivArgv(
  argv: string[],
  identity: AgentSandboxIdentity | typeof SANDBOX_USER,
): string[] {
  const uid = typeof identity === 'string' ? identity : String(identity.uid);
  const gid = typeof identity === 'string' ? identity : String(identity.gid);
  return [
    `--reuid=${uid}`,
    `--regid=${gid}`,
    '--clear-groups',
    '--no-new-privs',
    '--',
    ...argv,
  ];
}

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

let setprivUsable: boolean | null = null;

function canSetpriv(): boolean {
  if (process.platform !== 'linux') return false;
  if (setprivUsable !== null) return setprivUsable;
  if (process.getuid?.() !== 0 || !existsSync(SETPRIV) || !existsSync(FLOCK)) {
    setprivUsable = false;
    return false;
  }
  const probe = spawnSync(SETPRIV, setprivArgv(['/bin/true'], SANDBOX_USER), {
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
  `UID sandboxing is unavailable (needs root, ${SETPRIV}, ${FLOCK} and a ` +
  `"${SANDBOX_USER}" user); agent subprocesses share the runner's UID and ` +
  'can read its environment — including AGENT_RUNNER_TOKEN — via /proc.';
const DARWIN_FALLBACK_WARNING =
  'macOS seatbelt sandboxing is unavailable; Agent subprocesses share the ' +
  "Runner's uid and can read other sessions' workdirs and private .env files.";

export function enforceAgentSandboxPolicy(options: {
  available: boolean;
  platform: NodeJS.Platform;
  production: boolean;
  allowUnsandboxed: boolean;
}): void {
  if (options.available) return;
  const warning =
    options.platform === 'darwin'
      ? DARWIN_FALLBACK_WARNING
      : options.platform === 'linux'
        ? LINUX_FALLBACK_WARNING
        : `Agent sandboxing is unsupported on ${options.platform}; Agent ` +
          'subprocesses share the Runner identity and filesystem access.';
  if (options.production && !options.allowUnsandboxed) {
    throw new Error(
      `[shell-sandbox] ${warning} Refusing to start in production; set ` +
        'HATCH_ALLOW_UNSANDBOXED=true to accept this risk.',
    );
  }
  warnUnconfined(warning);
}

function requireRealDirectory(target: string, mode: number): void {
  mkdirSync(target, { recursive: true, mode });
  const info = lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`[shell-sandbox] ${target} must be a real directory.`);
  }
  chmodSync(target, mode);
}

function chownTree(
  targets: readonly string[],
  identity: AgentSandboxIdentity,
): void {
  if (targets.length === 0) return;
  const result = spawnSync(
    'chown',
    ['-hR', `${identity.uid}:${identity.gid}`, '--', ...targets],
    { encoding: 'utf8' },
  );
  if (result.status === 0) return;
  const reason =
    result.error?.message ||
    result.stderr?.trim() ||
    `exit ${result.status ?? 'unknown'}`;
  throw new Error(`[shell-sandbox] Could not set file ownership: ${reason}`);
}

function rootIdentity(): AgentSandboxIdentity {
  return { uid: 0, gid: 0 };
}

function validateIdentityFile(value: unknown): IdentityFile {
  if (value == null || typeof value !== 'object') {
    throw new Error('[shell-sandbox] Invalid Agent identity mapping.');
  }
  const candidate = value as Partial<IdentityFile>;
  if (
    candidate.version !== IDENTITY_FILE_VERSION ||
    !Number.isSafeInteger(candidate.nextUid) ||
    candidate.nextUid! < FIRST_SESSION_UID ||
    candidate.nextUid! > LAST_SESSION_UID + 1 ||
    candidate.sessions == null ||
    typeof candidate.sessions !== 'object' ||
    Array.isArray(candidate.sessions)
  ) {
    throw new Error('[shell-sandbox] Invalid Agent identity mapping.');
  }
  const used = new Set<number>();
  let largestUid = FIRST_SESSION_UID - 1;
  for (const [sessionId, identity] of Object.entries(candidate.sessions)) {
    if (
      !isSafePathSegment(sessionId) ||
      identity == null ||
      typeof identity !== 'object' ||
      !Number.isSafeInteger(identity.uid) ||
      !Number.isSafeInteger(identity.gid) ||
      identity.uid < FIRST_SESSION_UID ||
      identity.uid > LAST_SESSION_UID ||
      identity.gid !== identity.uid ||
      used.has(identity.uid)
    ) {
      throw new Error('[shell-sandbox] Invalid Agent identity mapping.');
    }
    used.add(identity.uid);
    largestUid = Math.max(largestUid, identity.uid);
  }
  if (candidate.nextUid! <= largestUid) {
    throw new Error('[shell-sandbox] Invalid Agent identity mapping.');
  }
  return candidate as IdentityFile;
}

function readIdentityFile(): IdentityFile {
  if (!existsSync(AGENT_IDENTITIES_PATH)) {
    return {
      version: IDENTITY_FILE_VERSION,
      nextUid: FIRST_SESSION_UID,
      sessions: {},
    };
  }
  const info = lstatSync(AGENT_IDENTITIES_PATH);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    info.gid !== 0 ||
    (info.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      '[shell-sandbox] Agent identity mapping must be a root-owned 0600 file.',
    );
  }
  return validateIdentityFile(
    JSON.parse(readFileSync(AGENT_IDENTITIES_PATH, 'utf8')),
  );
}

function syncDirectory(target: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      target,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensureIdentityLockFile(): void {
  requireRealDirectory(WORKSPACE_ROOT, 0o755);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      AGENT_IDENTITIES_LOCK_PATH,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NONBLOCK |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.uid !== 0 || info.gid !== 0) {
      throw new Error(
        '[shell-sandbox] Agent identity lock must be a root-owned file.',
      );
    }
    fchmodSync(descriptor, 0o600);
    fchownSync(descriptor, 0, 0);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  syncDirectory(WORKSPACE_ROOT);
}

// Allocation runs inside a child held by util-linux flock. Kernel locks are
// released automatically on process/container crashes, unlike PID lockfiles;
// this also makes rolling Runner restarts safe on a shared workspace volume.
const IDENTITY_ALLOCATOR_SCRIPT = String.raw`
import { randomUUID } from 'node:crypto';
import {
  chmodSync, chownSync, closeSync, constants, fchmodSync, fchownSync,
  fsyncSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const [mappingPath, sessionId, firstText, lastText, versionText] =
  process.argv.slice(1);
const first = Number(firstText);
const last = Number(lastText);
const version = Number(versionText);

function validSession(value) {
  return typeof value === 'string' && value.length > 0 &&
    value !== '.' && value !== '..' && !value.includes('/') &&
    !value.includes('\\') &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
}

function invalid() {
  throw new Error('Invalid Agent identity mapping.');
}

function validate(candidate) {
  if (candidate == null || typeof candidate !== 'object' ||
      candidate.version !== version ||
      !Number.isSafeInteger(candidate.nextUid) ||
      candidate.nextUid < first || candidate.nextUid > last + 1 ||
      candidate.sessions == null || typeof candidate.sessions !== 'object' ||
      Array.isArray(candidate.sessions)) invalid();
  const used = new Set();
  let largest = first - 1;
  for (const [id, identity] of Object.entries(candidate.sessions)) {
    if (!validSession(id) || identity == null ||
        typeof identity !== 'object' || !Number.isSafeInteger(identity.uid) ||
        !Number.isSafeInteger(identity.gid) || identity.uid < first ||
        identity.uid > last || identity.gid !== identity.uid ||
        used.has(identity.uid)) invalid();
    used.add(identity.uid);
    largest = Math.max(largest, identity.uid);
  }
  if (candidate.nextUid <= largest) invalid();
  return candidate;
}

function readMapping() {
  let descriptor;
  try {
    descriptor = openSync(
      mappingPath,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version, nextUid: first, sessions: {} };
    }
    throw error;
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.uid !== 0 || info.gid !== 0 ||
        (info.mode & 0o777) !== 0o600) invalid();
    return validate(JSON.parse(readFileSync(descriptor, 'utf8')));
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(directory) {
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeMapping(mapping) {
  const temporary = mappingPath + '.' + randomUUID() + '.tmp';
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, JSON.stringify(mapping, null, 2) + '\n', 'utf8');
    fchmodSync(descriptor, 0o600);
    fchownSync(descriptor, 0, 0);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, mappingPath);
    syncDirectory(path.dirname(mappingPath));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

if (!validSession(sessionId)) throw new Error('Invalid Agent session id.');
const mapping = readMapping();
let identity = mapping.sessions[sessionId];
if (!identity) {
  if (mapping.nextUid > last) throw new Error('Agent uid allocation exhausted.');
  identity = { uid: mapping.nextUid, gid: mapping.nextUid };
  mapping.sessions[sessionId] = identity;
  mapping.nextUid += 1;
  writeMapping(mapping);
}
process.stdout.write(JSON.stringify(identity));
`;

function identityForSession(sessionId: string): AgentSandboxIdentity {
  // Validate before using the id as a mapping key or path segment.
  agentSessionDir(sessionId);
  const cached = identityCache.get(sessionId);
  if (cached) return cached;
  ensureIdentityLockFile();
  const result = spawnSync(
    FLOCK,
    [
      '--exclusive',
      `--timeout=${IDENTITY_LOCK_TIMEOUT_MS / 1000}`,
      AGENT_IDENTITIES_LOCK_PATH,
      process.execPath,
      '--input-type=module',
      '--eval',
      IDENTITY_ALLOCATOR_SCRIPT,
      AGENT_IDENTITIES_PATH,
      sessionId,
      String(FIRST_SESSION_UID),
      String(LAST_SESSION_UID),
      String(IDENTITY_FILE_VERSION),
    ],
    {
      encoding: 'utf8',
      env: {},
      timeout: IDENTITY_LOCK_TIMEOUT_MS + 5000,
    },
  );
  if (result.status !== 0) {
    const reason =
      result.error?.message ||
      result.stderr.trim() ||
      `exit ${result.status ?? 'unknown'}`;
    throw new Error(
      `[shell-sandbox] Could not allocate Agent identity: ${reason}`,
    );
  }
  const mapping = readIdentityFile();
  const identity = mapping.sessions[sessionId];
  if (!identity || JSON.stringify(identity) !== result.stdout.trim()) {
    throw new Error(
      '[shell-sandbox] Agent identity allocation was not durable.',
    );
  }
  identityCache.set(sessionId, identity);
  return identity;
}

function ensureRootOwnedDirectory(target: string, mode: number): void {
  requireRealDirectory(target, mode);
  chownSync(target, 0, 0);
}

/**
 * Move files from the former shared HOME out of the per-session namespace.
 * A top-level entry is retained only when a matching session root exists.
 */
export function secureLegacyAgentHomes(): void {
  requireRealDirectory(
    AGENTS_DIR,
    process.platform === 'linux' ? 0o711 : 0o755,
  );
  requireRealDirectory(
    AGENT_HOME_DIR,
    process.platform === 'linux' ? 0o711 : 0o755,
  );
  const knownSessions = new Set(
    readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafePathSegment(entry.name))
      .map((entry) => entry.name),
  );
  const legacy = readdirSync(AGENT_HOME_DIR, { withFileTypes: true }).filter(
    (entry) =>
      !knownSessions.has(entry.name) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink(),
  );
  if (legacy.length === 0) return;

  requireRealDirectory(AGENT_LEGACY_HOME_DIR, 0o700);
  if (process.getuid?.() === 0) {
    chownSync(AGENT_LEGACY_HOME_DIR, 0, 0);
  }
  for (const entry of legacy) {
    const source = path.join(AGENT_HOME_DIR, entry.name);
    const destination = path.join(
      AGENT_LEGACY_HOME_DIR,
      `${entry.name}.${randomUUID()}`,
    );
    renameSync(source, destination);
  }
  syncDirectory(AGENT_HOME_DIR);
  syncDirectory(AGENT_LEGACY_HOME_DIR);
  syncDirectory(WORKSPACE_ROOT);
}

function secureExistingSessionLayouts(mapping: IdentityFile): void {
  for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    const session = path.join(AGENTS_DIR, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        '[shell-sandbox] Agent session roots must be directories.',
      );
    }
    const identity = mapping.sessions[entry.name];
    if (!identity) {
      // Preserve an old session until it is next used, but make its entire
      // tree Runner-only so already allocated sessions cannot traverse it.
      chownTree([session], rootIdentity());
      chmodSync(session, 0o700);
      chownSync(session, 0, 0);
      const home = path.join(AGENT_HOME_DIR, entry.name);
      if (existsSync(home)) {
        chownTree([home], rootIdentity());
        chmodSync(home, 0o700);
        chownSync(home, 0, 0);
      }
      continue;
    }

    const work = path.join(session, 'work');
    chownTree([session], rootIdentity());
    chmodSync(session, 0o710);
    chownSync(session, 0, identity.gid);
    if (existsSync(work)) {
      const workInfo = lstatSync(work);
      if (!workInfo.isDirectory() || workInfo.isSymbolicLink()) {
        throw new Error(
          '[shell-sandbox] Agent work roots must be directories.',
        );
      }
      chownTree([work], identity);
      chmodSync(work, 0o700);
    }
    const home = path.join(AGENT_HOME_DIR, entry.name);
    if (existsSync(home)) {
      const homeInfo = lstatSync(home);
      if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) {
        throw new Error(
          '[shell-sandbox] Agent home roots must be directories.',
        );
      }
      chownTree([home], identity);
      chmodSync(home, 0o700);
    }
  }
}

/** Prepare immutable session roots and the two directories its uid may write. */
export function prepareAgentSessionSandbox(
  sessionId: string,
): AgentSandboxIdentity | undefined {
  const session = agentSessionDir(sessionId);
  const work = agentWorkDir(sessionId);
  const home = agentHomeDir(sessionId);

  if (!canSetpriv()) {
    requireRealDirectory(session, 0o755);
    requireRealDirectory(work, 0o700);
    requireRealDirectory(home, 0o700);
    return undefined;
  }

  const identity = identityForSession(sessionId);
  ensureRootOwnedDirectory(AGENTS_DIR, 0o711);
  ensureRootOwnedDirectory(AGENT_HOME_DIR, 0o711);
  requireRealDirectory(session, 0o711);
  const sessionInfo = lstatSync(session);
  if (sessionInfo.uid !== 0 || sessionInfo.gid !== identity.gid) {
    // One-time migration from the former shared hatch-sandbox ownership.
    chownTree([session], rootIdentity());
  }
  chmodSync(session, 0o710);
  chownSync(session, 0, identity.gid);

  requireRealDirectory(work, 0o700);
  const workInfo = lstatSync(work);
  if (workInfo.uid !== identity.uid || workInfo.gid !== identity.gid) {
    chownTree([work], identity);
  }
  chmodSync(work, 0o700);

  requireRealDirectory(home, 0o700);
  const homeInfo = lstatSync(home);
  if (homeInfo.uid !== identity.uid || homeInfo.gid !== identity.gid) {
    chownTree([home], identity);
  }
  chmodSync(home, 0o700);
  return identity;
}

export function wrapShellCommand(command: string, sessionId?: string): string {
  if (sessionId) prepareAgentSessionSandbox(sessionId);
  if (process.platform === 'darwin') {
    if (!canSeatbelt()) {
      warnUnconfined(
        'sandbox-exec is unavailable; run_command is executing without the ' +
          'filesystem deny-list. Private environment files are not path-protected.',
      );
      return command;
    }
    return `${SANDBOX_EXEC} -p ${shQuote(buildProfile(sessionId))} /bin/sh -c ${shQuote(command)}`;
  }
  if (process.platform === 'linux') {
    if (!canSetpriv()) {
      warnUnconfined(LINUX_FALLBACK_WARNING);
      return command;
    }
    const identity = sessionId ? identityForSession(sessionId) : SANDBOX_USER;
    const shell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    const argv = setprivArgv([shell, '-c', command], identity);
    return `${SETPRIV} ${argv.map(shQuote).join(' ')}`;
  }
  return command;
}

export type SandboxedSpawn = { command: string; args: string[] };

export function sandboxSpawn(
  argv: [string, ...string[]],
  sessionId?: string,
): SandboxedSpawn {
  if (sessionId) prepareAgentSessionSandbox(sessionId);
  if (process.platform === 'darwin' && canSeatbelt()) {
    return {
      command: SANDBOX_EXEC,
      args: ['-p', buildProfile(sessionId), ...argv],
    };
  }
  if (!canSetpriv()) {
    const [command, ...args] = argv;
    return { command, args };
  }
  const identity = sessionId ? identityForSession(sessionId) : SANDBOX_USER;
  return { command: SETPRIV, args: setprivArgv(argv, identity) };
}

/** Spawn the fixed file helper under a fail-closed session boundary. */
export function sandboxFileSpawn(
  argv: [string, ...string[]],
  sessionId: string,
  readOnlyRoots: readonly string[] = [],
): SandboxedSpawn {
  prepareAgentSessionSandbox(sessionId);
  if (process.platform === 'darwin' && canSeatbelt()) {
    return {
      command: SANDBOX_EXEC,
      args: ['-p', buildFileProfile(sessionId, readOnlyRoots), ...argv],
    };
  }
  if (process.platform === 'linux' && canSetpriv()) {
    return {
      command: SETPRIV,
      args: setprivArgv(argv, identityForSession(sessionId)),
    };
  }
  const { production, allowUnsandboxed } = getAgentRunnerEnv();
  enforceAgentSandboxPolicy({
    available: false,
    platform: process.platform,
    production,
    allowUnsandboxed,
  });
  // Dev and explicit HATCH_ALLOW_UNSANDBOXED deployments retain the helper's
  // no-follow/path-containment checks, but lack a separate OS identity. This
  // is the same opt-in degradation as run_command, never a silent fallback.
  const [command, ...args] = argv;
  return { command, args };
}

type AgentOwnedTargetScope =
  | { kind: 'outside' }
  | { kind: 'namespace' }
  | { kind: 'session'; sessionId: string };

function agentOwnedTargetScope(target: string): AgentOwnedTargetScope {
  const absolute = path.resolve(target);
  for (const root of [AGENTS_DIR, AGENT_HOME_DIR]) {
    const relative = path.relative(root, absolute);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    if (relative === '') return { kind: 'namespace' };
    const [sessionId] = relative.split(path.sep);
    if (!sessionId || !isSafePathSegment(sessionId)) {
      return { kind: 'namespace' };
    }
    return { kind: 'session', sessionId };
  }
  return { kind: 'outside' };
}

/**
 * Resolve an implicit ownership transfer without guessing across trust roots.
 * Platform build paths are intentionally outside the Agent namespaces and
 * therefore keep their current owner. Callers may still explicitly name a
 * session for temporary paths they deliberately created on its behalf.
 */
export function resolveAgentOwnershipSession(
  targets: readonly string[],
  explicitSessionId?: string,
): string | undefined {
  if (targets.length === 0) return undefined;
  if (explicitSessionId !== undefined) agentSessionDir(explicitSessionId);

  const scopes = targets.map(agentOwnedTargetScope);
  if (scopes.some(({ kind }) => kind === 'namespace')) {
    throw new Error(
      '[shell-sandbox] Cannot change ownership of an Agent namespace root.',
    );
  }
  const sessions = new Set(
    scopes.flatMap((scope) =>
      scope.kind === 'session' ? [scope.sessionId] : [],
    ),
  );

  if (explicitSessionId !== undefined) {
    if ([...sessions].some((sessionId) => sessionId !== explicitSessionId)) {
      throw new Error(
        '[shell-sandbox] Ownership targets belong to another Agent session.',
      );
    }
    return explicitSessionId;
  }

  if (sessions.size === 0) return undefined;
  if (sessions.size !== 1 || scopes.some(({ kind }) => kind === 'outside')) {
    throw new Error(
      '[shell-sandbox] Ownership targets must belong to one Agent session.',
    );
  }
  return sessions.values().next().value;
}

/** Transfer Runner-generated paths to one session's numeric identity. */
export function setAgentOwned(
  targets: readonly string[],
  sessionId?: string,
): void {
  if (targets.length === 0 || !canSetpriv()) return;
  const inferred = resolveAgentOwnershipSession(targets, sessionId);
  // Platform build/materialization roots are Runner-owned and must remain so.
  if (!inferred) return;
  const identity = prepareAgentSessionSandbox(inferred)!;
  chownTree(targets, identity);
}

/** Make Runner-private session metadata root-owned after an atomic move. */
export function setRunnerOwned(targets: readonly string[]): void {
  if (targets.length === 0 || !canSetpriv()) return;
  chownTree(targets, rootIdentity());
}

/** Prepare global sandbox roots before accepting Runner work. */
export function initializeAgentSandbox(): void {
  if (process.platform === 'darwin') {
    requireRealDirectory(AGENTS_DIR, 0o755);
    requireRealDirectory(AGENT_HOME_DIR, 0o755);
    secureLegacyAgentHomes();
    const { production, allowUnsandboxed } = getAgentRunnerEnv();
    enforceAgentSandboxPolicy({
      available: canSeatbelt(),
      platform: 'darwin',
      production,
      allowUnsandboxed,
    });
    return;
  }
  if (!canSetpriv()) {
    const { production, allowUnsandboxed } = getAgentRunnerEnv();
    enforceAgentSandboxPolicy({
      available: false,
      platform: process.platform,
      production,
      allowUnsandboxed,
    });
    return;
  }
  ensureRootOwnedDirectory(AGENTS_DIR, 0o711);
  ensureRootOwnedDirectory(AGENT_HOME_DIR, 0o711);
  secureLegacyAgentHomes();
  ensureIdentityLockFile();
  secureExistingSessionLayouts(readIdentityFile());
  console.log(
    '[shell-sandbox] agent subprocesses use per-session uid/gid pairs',
  );
  return;
}
