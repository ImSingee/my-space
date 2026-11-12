/** Resolve the APNs signing credentials this instance uses. */
import { createPrivateKey, type KeyObject } from 'node:crypto';
import type { NotificationApnsEnvironment } from '~/db/schema';
import { SHARED_APNS_CREDENTIALS } from './shared-credentials';

export type ApnsKey = { keyId: string; key: KeyObject };

export type ApnsCredentials = {
  source: 'builtin' | 'environment';
  teamId: string | null;
  topic: string;
  keys: Record<NotificationApnsEnvironment, ApnsKey | null>;
};

const ENV_PREFIX = 'HATCH_APNS_';

function readKey(
  keyId: string | undefined,
  privateKey: string | undefined,
  label: string,
): ApnsKey | null {
  const id = keyId?.trim();
  const pem = privateKey?.trim().replaceAll('\\n', '\n');
  if (!id && !pem) return null;
  if (!id || !pem) {
    throw new Error(
      `${label} needs both a key id and a private key to sign APNs requests.`,
    );
  }
  if (!/^[A-Z0-9]{10}$/.test(id)) {
    throw new Error(`${label} key id must be the 10-character Apple key id.`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error(`${label} private key is not a valid PEM (.p8) key.`);
  }
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(`${label} private key must be an APNs ES256 key.`);
  }
  return { keyId: id, key };
}

function hasEnvironmentOverride(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some(
    (name) => name.startsWith(ENV_PREFIX) && env[name]?.trim(),
  );
}

/**
 * Environment variables replace the built-in shared credentials as a whole
 * (for instances that ship their own iOS build), so a partial override can
 * never mix two Apple teams.
 */
export function resolveApnsCredentials(
  env: NodeJS.ProcessEnv = process.env,
): ApnsCredentials {
  if (hasEnvironmentOverride(env)) {
    const teamId = env.HATCH_APNS_TEAM_ID?.trim();
    const topic = env.HATCH_APNS_TOPIC?.trim();
    if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId)) {
      throw new Error('HATCH_APNS_TEAM_ID must be the 10-character team id.');
    }
    if (!topic) throw new Error('HATCH_APNS_TOPIC must be the app bundle id.');
    const production = readKey(
      env.HATCH_APNS_PRODUCTION_KEY_ID,
      env.HATCH_APNS_PRODUCTION_PRIVATE_KEY,
      'HATCH_APNS_PRODUCTION',
    );
    const sandbox = readKey(
      env.HATCH_APNS_SANDBOX_KEY_ID,
      env.HATCH_APNS_SANDBOX_PRIVATE_KEY,
      'HATCH_APNS_SANDBOX',
    );
    if (!production && !sandbox) {
      throw new Error(
        'Configure HATCH_APNS_PRODUCTION_* and/or HATCH_APNS_SANDBOX_* keys.',
      );
    }
    return {
      source: 'environment',
      teamId,
      topic,
      keys: { production, sandbox },
    };
  }
  const shared = SHARED_APNS_CREDENTIALS;
  return {
    source: 'builtin',
    teamId: shared.teamId,
    topic: shared.topic,
    keys: {
      production: shared.production
        ? readKey(
            shared.production.keyId,
            shared.production.privateKey,
            'Built-in production APNs',
          )
        : null,
      sandbox: shared.sandbox
        ? readKey(
            shared.sandbox.keyId,
            shared.sandbox.privateKey,
            'Built-in sandbox APNs',
          )
        : null,
    },
  };
}

let cached: { value: ApnsCredentials } | { error: string } | undefined;

/** Resolve once per process; configuration errors surface on every use. */
export function getApnsCredentials(): ApnsCredentials {
  if (!cached) {
    try {
      cached = { value: resolveApnsCredentials() };
    } catch (error) {
      cached = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if ('error' in cached) throw new Error(cached.error);
  return cached.value;
}

/** Non-secret summary for the settings page. */
export function describeApnsCredentials(): {
  source: 'builtin' | 'environment';
  topic: string | null;
  production: boolean;
  sandbox: boolean;
  error: string | null;
} {
  try {
    const credentials = getApnsCredentials();
    const usable = Boolean(credentials.teamId);
    return {
      source: credentials.source,
      topic: credentials.topic,
      production: usable && Boolean(credentials.keys.production),
      sandbox: usable && Boolean(credentials.keys.sandbox),
      error: null,
    };
  } catch (error) {
    return {
      source: 'environment',
      topic: null,
      production: false,
      sandbox: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
