/** Agent Runner configuration, read once from the environment. */
import os from 'node:os';
import { RUNNER_WS_PATH } from '~agent/protocol';

export type RunnerConfig = {
  /** Platform internal API base, e.g. http://127.0.0.1:3701 (no trailing /). */
  platformUrl: string;
  /** WebSocket control channel URL derived from platformUrl. */
  wsUrl: string;
  /** Shared bearer secret (AGENT_RUNNER_TOKEN on both services). */
  token: string;
  /** Stable identity for lease ownership across reconnects/restarts. */
  runnerId: string;
};

/** Dev fallback mirrored by the platform's internal server. */
const DEV_TOKEN = 'hatch-dev-runner-token';

export function loadRunnerConfig(): RunnerConfig {
  const platformUrl = (
    process.env.HATCH_PLATFORM_URL ?? 'http://127.0.0.1:3701'
  ).replace(/\/+$/, '');

  let token = process.env.AGENT_RUNNER_TOKEN?.trim() ?? '';
  if (!token) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('AGENT_RUNNER_TOKEN is required in production.');
    }
    token = DEV_TOKEN;
  }

  const runnerId =
    process.env.HATCH_RUNNER_ID?.trim() || `runner-${os.hostname()}`;

  const wsUrl = platformUrl.replace(/^http/, 'ws') + RUNNER_WS_PATH;
  return { platformUrl, wsUrl, token, runnerId };
}
