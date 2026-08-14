/** Environment names that stored values must never override in a command. */
const RESERVED_ENV_KEYS = new Set([
  'BASHOPTS',
  'BASH_ENV',
  'CDPATH',
  'COREPACK_HOME',
  'DENO_DIR',
  'DENO_INSTALL_ROOT',
  'ENV',
  'GIT_ASKPASS',
  'GLOBIGNORE',
  'HOME',
  'IFS',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'OLDPWD',
  'PATH',
  'PNPM_HOME',
  'PROMPT_COMMAND',
  'PS4',
  'PWD',
  'SHELL',
  'SHELLOPTS',
  'SSH_ASKPASS',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'ZDOTDIR',
]);

const RESERVED_ENV_PREFIXES = [
  'DYLD_',
  'GIT_CONFIG_',
  'HATCH_',
  'LD_',
  'XDG_',
] as const;

export const ENV_KEY_PATTERN = '^[A-Za-z_][A-Za-z0-9_]{0,63}$';
const ENV_KEY_RE = new RegExp(ENV_KEY_PATTERN);

export function isReservedEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (
    RESERVED_ENV_KEYS.has(normalized) ||
    RESERVED_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

/** Validate a model-visible environment key without ever handling its value. */
export function requireEnvKey(key: string): string {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(
      `Invalid environment key "${key}": use 1-64 letters, digits, or underscores ` +
        'and do not start with a digit.',
    );
  }
  if (isReservedEnvKey(key)) {
    throw new Error(
      `Environment key "${key}" is reserved by the command runtime.`,
    );
  }
  return key;
}
