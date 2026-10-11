import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError } from './error';

export type Profile = { url: string; token?: string; apiKey?: string };
type Config = {
  version: 1;
  activeProfile: string;
  profiles: Record<string, Profile>;
};

export function normalizeUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new CliError(
      'invalid_url',
      'Use an HTTPS origin (HTTP is allowed only on localhost).',
    );
  }
}

export function validateToken(value: string): string {
  if (!value || value.length > 8192 || /\s/.test(value))
    throw new CliError(
      'invalid_token_input',
      'The token must be a single nonempty value.',
    );
  return value;
}

export function configPath(env: NodeJS.ProcessEnv, override?: string): string {
  if (override) return override;
  const home = env.HOME || homedir();
  if (process.platform === 'win32')
    return join(
      env.APPDATA || join(home, 'AppData', 'Roaming'),
      'Hatch',
      'cli',
      'config.json',
    );
  if (process.platform === 'darwin')
    return join(
      home,
      'Library',
      'Application Support',
      'Hatch',
      'cli',
      'config.json',
    );
  return join(
    env.XDG_CONFIG_HOME || join(home, '.config'),
    'hatch',
    'cli',
    'config.json',
  );
}

export function environmentCredential(env: NodeJS.ProcessEnv): Profile | null {
  if (
    [env.HATCH_CLI_URL, env.HATCH_CLI_TOKEN, env.HATCH_CLI_API_KEY].every(
      (value) => value === undefined,
    )
  )
    return null;
  const tokenPresent = env.HATCH_CLI_TOKEN !== undefined;
  const keyPresent = env.HATCH_CLI_API_KEY !== undefined;
  if (
    !env.HATCH_CLI_URL?.trim() ||
    tokenPresent === keyPresent ||
    !(tokenPresent ? env.HATCH_CLI_TOKEN : env.HATCH_CLI_API_KEY)?.trim()
  )
    throw new CliError(
      'incomplete_env',
      'Supply HATCH_CLI_URL and exactly one nonempty HATCH_CLI_TOKEN or HATCH_CLI_API_KEY.',
    );
  return {
    url: normalizeUrl(env.HATCH_CLI_URL),
    ...(tokenPresent
      ? { token: validateToken(env.HATCH_CLI_TOKEN!) }
      : { apiKey: validateToken(env.HATCH_CLI_API_KEY!) }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function readConfig(path: string): Promise<Config | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 1024 * 1024 ||
      (process.platform !== 'win32' &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new Error();
    const raw: unknown = JSON.parse(await file.readFile('utf8'));
    if (
      !isObject(raw) ||
      raw.version !== 1 ||
      typeof raw.activeProfile !== 'string' ||
      !isObject(raw.profiles)
    )
      throw new Error();
    const profiles: Record<string, Profile> = Object.create(null);
    for (const [name, value] of Object.entries(raw.profiles)) {
      if (
        !name ||
        !isObject(value) ||
        typeof value.url !== 'string' ||
        Object.hasOwn(value, 'token') === Object.hasOwn(value, 'apiKey') ||
        (Object.hasOwn(value, 'token') && typeof value.token !== 'string') ||
        (Object.hasOwn(value, 'apiKey') && typeof value.apiKey !== 'string')
      )
        throw new Error();
      if (
        typeof value.token === 'string' &&
        value.token.split('.').length === 3
      )
        throw new Error('Run credentials belong in env.');
      profiles[name] = {
        url: normalizeUrl(value.url),
        ...(typeof value.token === 'string'
          ? { token: validateToken(value.token) }
          : { apiKey: validateToken(String(value.apiKey)) }),
      };
    }
    return { version: 1, activeProfile: raw.activeProfile, profiles };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CliError(
      'invalid_config',
      'Cannot read CLI configuration. Check its format, ownership and private permissions.',
    );
  } finally {
    await file?.close();
  }
}

export type Credential = Profile & {
  source: 'env' | 'config';
  profile?: string;
};

export async function resolveCredential(
  env: NodeJS.ProcessEnv,
  path: string,
  profile?: string,
): Promise<Credential> {
  const injected = environmentCredential(env);
  if (injected) {
    if (profile !== undefined)
      throw new CliError(
        'source_conflict',
        '--profile cannot be combined with environment credentials.',
      );
    return { ...injected, source: 'env' };
  }
  const config = await readConfig(path);
  if (!config)
    throw new CliError(
      'not_authenticated',
      'Not authenticated. Run hatch auth login.',
      3,
    );
  const names = Object.keys(config.profiles);
  const name =
    profile ??
    (config.activeProfile || (names.length === 1 ? names[0] : undefined));
  const selected = name === undefined ? undefined : config.profiles[name];
  if (!selected)
    throw new CliError(
      'profile_not_found',
      'Select an existing profile with --profile.',
    );
  return { ...selected, source: 'config', profile: name };
}

/** Read the latest config under a lock, then replace it atomically at mode 0600. */
export async function saveProfile(
  path: string,
  name: string,
  profile: Profile | null,
  expected?: Profile,
) {
  const lock = `${path}.lock`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new CliError(
      'config_locked',
      'CLI configuration is locked. Retry after the other login finishes.',
      6,
    );
  }
  try {
    const config = (await readConfig(path)) ?? {
      version: 1 as const,
      activeProfile: name,
      profiles: Object.create(null) as Record<string, Profile>,
    };
    if (expected) {
      const latest = config.profiles[name];
      if (
        !latest ||
        latest.url !== expected.url ||
        latest.token !== expected.token ||
        latest.apiKey !== expected.apiKey
      )
        throw new CliError(
          'config_changed',
          'Profile changed during logout; the newer profile was preserved.',
          6,
        );
    }
    if (profile) {
      config.profiles[name] = profile;
      config.activeProfile = name;
    } else {
      delete config.profiles[name];
      if (config.activeProfile === name)
        config.activeProfile = Object.keys(config.profiles)[0] ?? '';
    }
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
