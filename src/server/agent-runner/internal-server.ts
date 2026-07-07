/**
 * Server-only: the platform's runner-facing internal server.
 *
 * A dedicated `node:http` server (default port 3701, never published outside
 * the deployment network) carrying:
 *   - the runner WebSocket control channel (RUNNER_WS_PATH), and
 *   - the internal REST API the runner's PlatformClient calls.
 *
 * Every request/upgrade must present the shared AGENT_RUNNER_TOKEN as a
 * Bearer token. This server is the ONLY platform surface the Agent Runner
 * talks to — the runner never gets database credentials or a session cookie.
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { DEFAULT_INTERNAL_PORT, RUNNER_WS_PATH } from '~agent/protocol';
import { secretsMatch } from '~server/secrets';
import { handleInternalApiRequest } from './internal-api';
import { handleRunnerSocket } from './hub';

type InternalServerGlobal = typeof globalThis & {
  __hatchInternalServer__?: { server: http.Server; port: number };
};

/** Dev fallback so local platform + runner scripts work with zero setup. */
const DEV_TOKEN = 'hatch-dev-runner-token';

export function agentRunnerToken(): string | null {
  const token = process.env.AGENT_RUNNER_TOKEN?.trim();
  if (process.env.NODE_ENV !== 'production') return token || DEV_TOKEN;
  // Production: require an explicit secret. The well-known dev fallback is
  // as good as no token (any local process could impersonate the runner), so
  // treat it as unset and keep the endpoint disabled.
  if (!token || token === DEV_TOKEN) return null;
  return token;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function startAgentInternalServer(): void {
  const g = globalThis as InternalServerGlobal;
  if (g.__hatchInternalServer__) return;

  const token = agentRunnerToken();
  if (!token) {
    console.warn(
      '[agent-internal] AGENT_RUNNER_TOKEN is not set; the Agent Runner ' +
        'endpoint is disabled and agent runs cannot be dispatched.',
    );
    return;
  }

  const port = Number(process.env.AGENT_INTERNAL_PORT) || DEFAULT_INTERNAL_PORT;
  // Loopback by default for local dev; deployments (docker-compose) set
  // 0.0.0.0 so the runner container can reach it over the compose network.
  const host = process.env.AGENT_INTERNAL_HOST || '127.0.0.1';

  const authorized = (req: http.IncomingMessage): boolean =>
    secretsMatch(bearerToken(req.headers.authorization), token);

  const server = http.createServer((req, res) => {
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    void handleInternalApiRequest(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== RUNNER_WS_PATH || !authorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleRunnerSocket(ws);
    });
  });

  server.on('error', (error) => {
    console.error('[agent-internal] server error:', error);
  });

  server.listen(port, host, () => {
    console.log(`[agent-internal] listening on ${host}:${port}`);
  });
  g.__hatchInternalServer__ = { server, port };
}
