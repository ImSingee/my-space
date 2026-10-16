import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError } from './error';
import {
  configPath,
  environmentCredential,
  normalizeUrl,
  resolveCredential,
  saveProfile,
  validateToken,
} from './config';
import { getStatus, record, request } from './http';
import type { AuthStatus } from './http';

async function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'rundll32.exe'
        : 'xdg-open';
  const args =
    process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'SYSTEMROOT',
    'WINDIR',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', env, timeout: 5000 });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

async function deviceLogin(
  url: string,
  noBrowser: boolean,
  timeout: number,
  signal: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + timeout;
  const { response, body } = await request(url, '/api/auth/device/code', {
    body: { client_id: 'hatch-cli' },
    timeout: Math.min(timeout, 15000),
    signal,
  });
  if (!response.ok)
    throw new CliError(
      'device_request_failed',
      'Could not start device login.',
      7,
    );
  const grant = record(body);
  if (
    typeof grant.device_code !== 'string' ||
    !grant.device_code ||
    typeof grant.user_code !== 'string' ||
    !/^[A-Za-z0-9-]{1,64}$/.test(grant.user_code) ||
    typeof grant.verification_uri_complete !== 'string' ||
    typeof grant.expires_in !== 'number' ||
    !Number.isFinite(grant.expires_in) ||
    grant.expires_in <= 0 ||
    (grant.interval !== undefined &&
      (typeof grant.interval !== 'number' ||
        !Number.isFinite(grant.interval) ||
        grant.interval <= 0))
  )
    throw new CliError(
      'invalid_response',
      'The platform returned an invalid device grant.',
      7,
    );
  let verification: URL;
  try {
    verification = new URL(grant.verification_uri_complete);
  } catch {
    throw new CliError(
      'invalid_response',
      'The platform returned an invalid verification URL.',
      7,
    );
  }
  if (
    verification.origin !== url ||
    verification.username ||
    verification.password ||
    verification.pathname !== '/cli/authorize'
  )
    throw new CliError(
      'instance_mismatch',
      'The verification URL belongs to a different instance.',
    );
  process.stderr.write(
    `Open ${verification.href}\nCode: ${grant.user_code}\nApprove only a request you started. This grants full account access.\n`,
  );
  if (!noBrowser && !(await openBrowser(verification.href)))
    process.stderr.write(
      'Could not open the browser. Open the URL above manually.\n',
    );
  const expires = Math.min(deadline, Date.now() + grant.expires_in * 1000);
  let interval =
    typeof grant.interval === 'number' ? grant.interval * 1000 : 5000;
  while (Date.now() < expires) {
    const remaining = expires - Date.now();
    try {
      await delay(Math.min(interval, remaining), undefined, {
        signal,
      });
    } catch {
      throw new CliError('cancelled', 'Cancelled.', 130);
    }
    if (interval >= remaining || Date.now() >= expires) break;
    const result = await request(url, '/api/auth/device/token', {
      body: {
        client_id: 'hatch-cli',
        device_code: grant.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      },
      timeout: Math.min(15000, expires - Date.now()),
      signal,
    });
    const data = record(result.body);
    if (result.response.ok && typeof data.access_token === 'string')
      return validateToken(data.access_token);
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down' || result.response.status === 429) {
      interval += 5000;
      continue;
    }
    if (data.error === 'access_denied')
      throw new CliError('access_denied', 'Device login was denied.', 4);
    if (data.error === 'expired_token')
      throw new CliError(
        'expired_token',
        'Device login expired. Start a new login.',
        3,
      );
    throw new CliError(
      'device_login_failed',
      'Device login failed. Start a new login.',
      3,
    );
  }
  throw new CliError(
    'login_timeout',
    'Device login timed out. Start a new login.',
    7,
  );
}

function outputStatus(
  status: AuthStatus,
  source: string,
  url: string,
  profile: string | undefined,
  json: boolean,
) {
  const safe = {
    ...status,
    source,
    url,
    ...(profile === undefined ? {} : { profile }),
  };
  if (json) process.stdout.write(`${JSON.stringify(safe)}\n`);
  else
    process.stdout.write(
      [
        'Authenticated',
        `Source: ${source}${profile ? ` (${profile})` : ''}`,
        `Instance: ${url}`,
        `Credential: ${status.credentialType}`,
        `Authority: ${status.authority}`,
        ...('user' in status ? [`User: ${status.user.email}`] : []),
        ...('context' in status
          ? [
              `Run: ${status.context.runId}`,
              `Session: ${status.context.sessionId}`,
              `Runner: ${status.context.runnerId}`,
            ]
          : []),
        `Expires: ${status.expiresAt}`,
        '',
      ].join('\n'),
    );
}

export async function runAuth(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const command = args[offset + 1];
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 2)],
      options: {
        json: { type: 'boolean' },
        profile: { type: 'string' },
        config: { type: 'string' },
        timeout: { type: 'string' },
        ...(command === 'login'
          ? {
              url: { type: 'string' as const },
              'no-browser': { type: 'boolean' as const },
              'api-key-file': { type: 'string' as const },
            }
          : command === 'logout'
            ? { 'local-only': { type: 'boolean' as const } }
            : {}),
      },
      allowPositionals: false,
    });
  } catch {
    throw new CliError(
      'invalid_arguments',
      'Invalid auth arguments. See the CLI README for usage.',
    );
  }
  const values = parsed.values as {
    json?: boolean;
    profile?: string;
    config?: string;
    timeout?: string;
    url?: string;
    'no-browser'?: boolean;
    'api-key-file'?: string;
    'local-only'?: boolean;
  };
  const profile = values.profile;
  if (
    (profile !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) ||
    values.config === ''
  )
    throw new CliError('invalid_arguments', 'Invalid profile or config path.');
  const seconds =
    values.timeout === undefined
      ? command === 'login'
        ? 600
        : 15
      : Number(values.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be greater than 0 and at most 3600 seconds.',
    );
  const timeout = Math.ceil(seconds * 1000);
  const path = configPath(process.env, values.config);
  if (command === 'status') {
    const credential = await resolveCredential(process.env, path, profile);
    const status = await getStatus(credential, timeout, signal);
    outputStatus(
      status,
      credential.source,
      credential.url,
      credential.profile,
      !!values.json,
    );
    return;
  }
  if (command === 'logout') {
    const credential = await resolveCredential(process.env, path, profile);
    if (credential.source === 'env')
      throw new CliError(
        'env_logout_forbidden',
        'Environment credentials are externally managed; unset them and revoke at their issuer.',
      );
    let revoked = false;
    if (!values['local-only']) {
      if (credential.apiKey)
        throw new CliError(
          'session_required',
          'API key revocation requires an account session. Revoke in Settings, or use --local-only to only forget this profile.',
        );
      await getStatus(credential, timeout, signal);
      const result = await request(credential.url, '/api/auth/sign-out', {
        token: credential.token,
        body: {},
        timeout,
        signal,
      });
      if (!result.response.ok)
        throw new CliError(
          'revoke_failed',
          'Server did not confirm revocation; local profile retained.',
          7,
        );
      revoked = true;
    }
    if (signal.aborted)
      throw new CliError(
        'cancelled',
        'Cancelled; inspect server revocation state.',
        130,
      );
    await saveProfile(path, credential.profile!, null, credential);
    const result = {
      authenticated: false,
      profile: credential.profile,
      removed: true,
      revoked,
    };
    process.stdout.write(
      values.json
        ? `${JSON.stringify(result)}\n`
        : revoked
          ? 'Session revoked and local profile removed.\n'
          : 'Local profile removed; server credential was not revoked.\n',
    );
    return;
  }
  if (environmentCredential(process.env))
    throw new CliError(
      'env_login_forbidden',
      'Environment credentials are used directly; unset them before saving a local login.',
    );
  let url: string;
  let selectedProfile = profile;
  if (typeof values.url === 'string') url = normalizeUrl(values.url);
  else {
    try {
      const selected = await resolveCredential(process.env, path, profile);
      url = selected.url;
      selectedProfile = selected.profile;
    } catch (error) {
      if (error instanceof CliError && error.code === 'invalid_config')
        throw error;
      throw new CliError(
        'url_required',
        'Provide --url <instance-origin> for a new login.',
      );
    }
  }
  if (values['api-key-file'] && values['no-browser'])
    throw new CliError(
      'invalid_arguments',
      '--api-key-file cannot be combined with --no-browser.',
    );
  const credential = values['api-key-file']
    ? { url, apiKey: await readApiKey(values['api-key-file']) }
    : {
        url,
        token: await deviceLogin(url, !!values['no-browser'], timeout, signal),
      };
  const status = await getStatus(credential, Math.min(timeout, 15000), signal);
  if (status.credentialType === 'run')
    throw new CliError(
      'run_token_not_persisted',
      'Run tokens must be supplied through HATCH_CLI_URL and HATCH_CLI_TOKEN.',
    );
  const expected = credential.apiKey ? 'api-key' : 'session';
  if (status.credentialType !== expected)
    throw new CliError(
      'credential_type_mismatch',
      `Expected a ${expected} credential; the server reported ${status.credentialType}. No credential was saved.`,
    );
  if (signal.aborted) throw new CliError('cancelled', 'Cancelled.', 130);
  const name = selectedProfile ?? 'default';
  await saveProfile(path, name, credential);
  outputStatus(status, 'config', url, name, !!values.json);
}

async function readApiKey(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => {
    throw new CliError('invalid_key_file', 'Cannot read private API key file.');
  });
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 8194 ||
      (process.platform !== 'win32' &&
        (stat.mode & 0o077 || stat.uid !== process.getuid?.()))
    )
      throw new CliError(
        'invalid_key_file',
        'API key file must be a private regular file owned by you.',
      );
    return validateToken((await file.readFile('utf8')).trim());
  } finally {
    await file.close();
  }
}
