import os from 'node:os';
import {
  DEFAULT_INTERNAL_PORT,
  RUNNER_WS_PATH,
} from './agent/runner-constants';

const DEV_AGENT_RUNNER_TOKEN = 'hatch-dev-runner-token';

/** Immutable startup configuration for the Platform process. */
export type PlatformEnv = Readonly<{
  /** Root key used to derive per-app database passwords. */
  secret: string;
  /** Better Auth key, falling back to `secret` when not configured separately. */
  betterAuthSecret: string;
  /** Shared Runner bearer token, or null when the production endpoint is disabled. */
  agentRunnerToken: string | null;
  agentInternalHost: string;
  agentInternalPort: number;
}>;

/** Immutable startup configuration for the Agent Runner process. */
export type AgentRunnerEnv = Readonly<{
  /** Platform internal API base URL without a trailing slash. */
  platformUrl: string;
  /** WebSocket control-channel URL derived from `platformUrl`. */
  wsUrl: string;
  /** Shared bearer token sent to the Platform. */
  token: string;
  /** Stable identity used for run lease ownership. */
  runnerId: string;
  production: boolean;
  allowUnsandboxed: boolean;
}>;

let platformEnv: PlatformEnv | undefined;
let agentRunnerEnv: AgentRunnerEnv | undefined;

function resolvePlatformEnv(): PlatformEnv {
  const secret = process.env.SECRET;
  if (!secret?.trim()) {
    throw new Error('SECRET is not set');
  }

  const configuredBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
  const betterAuthSecret = configuredBetterAuthSecret?.trim()
    ? configuredBetterAuthSecret
    : secret;

  const configuredAgentRunnerToken = process.env.AGENT_RUNNER_TOKEN?.trim();
  const production = process.env.NODE_ENV === 'production';
  const agentRunnerToken = production
    ? configuredAgentRunnerToken &&
      configuredAgentRunnerToken !== DEV_AGENT_RUNNER_TOKEN
      ? configuredAgentRunnerToken
      : null
    : configuredAgentRunnerToken || DEV_AGENT_RUNNER_TOKEN;

  return Object.freeze({
    secret,
    betterAuthSecret,
    agentRunnerToken,
    agentInternalHost: process.env.AGENT_INTERNAL_HOST || '127.0.0.1',
    agentInternalPort:
      Number(process.env.AGENT_INTERNAL_PORT) || DEFAULT_INTERNAL_PORT,
  });
}

function resolveAgentRunnerEnv(): AgentRunnerEnv {
  const production = process.env.NODE_ENV === 'production';
  const platformUrl = (
    process.env.HATCH_PLATFORM_URL ?? 'http://127.0.0.1:3701'
  ).replace(/\/+$/, '');

  let token = process.env.AGENT_RUNNER_TOKEN?.trim() ?? '';
  if (!token) {
    if (production) {
      throw new Error('AGENT_RUNNER_TOKEN is required in production.');
    }
    token = DEV_AGENT_RUNNER_TOKEN;
  }

  return Object.freeze({
    platformUrl,
    wsUrl: platformUrl.replace(/^http/, 'ws') + RUNNER_WS_PATH,
    token,
    runnerId: process.env.HATCH_RUNNER_ID?.trim() || `runner-${os.hostname()}`,
    production,
    allowUnsandboxed: process.env.HATCH_ALLOW_UNSANDBOXED === 'true',
  });
}

/** Resolve once per Platform process, then return the frozen snapshot. */
export function getPlatformEnv(): PlatformEnv {
  platformEnv ??= resolvePlatformEnv();
  return platformEnv;
}

/** Resolve once per Agent Runner process, then return the frozen snapshot. */
export function getAgentRunnerEnv(): AgentRunnerEnv {
  agentRunnerEnv ??= resolveAgentRunnerEnv();
  return agentRunnerEnv;
}
