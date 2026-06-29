/**
 * Server-only: build the environment handed to an untrusted Deno subprocess
 * (deployed app backends and author-written workflows).
 *
 * Such subprocesses run with `--allow-env`, so they must never inherit the
 * platform's `process.env` (which holds `DATABASE_URL`, auth secrets, provider
 * API keys, etc.). This exposes only the system variables Deno itself needs to
 * resolve its binary and module cache, plus any explicit variables the caller
 * passes in (e.g. the app's own per-app `DATABASE_URL`).
 */
const SANDBOX_ENV_ALLOWLIST = [
  // Needed to locate the `deno` binary and write/read its module cache.
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'DENO_DIR',
  'DENO_INSTALL_ROOT',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  // Locale / TLS trust so network + text handling behave like the host.
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Windows essentials (harmless no-ops on POSIX).
  'SystemRoot',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
] as const;

export function subprocessSandboxEnv(
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}
