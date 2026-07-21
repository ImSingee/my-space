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
import { RUNNER_WS_PATH } from '~agent/protocol';
import { getPlatformEnv } from '~env';
import { secretsMatch } from '~server/secrets';
import { handleInternalApiRequest } from './internal-api';
import { handleRunnerSocket } from './hub';

type InternalServerGlobal = typeof globalThis & {
  __hatchInternalServer__?: { server: http.Server; port: number };
};

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function startAgentInternalServer(): void {
  const g = globalThis as InternalServerGlobal;
  if (g.__hatchInternalServer__) return;

  const {
    agentRunnerToken: token,
    agentInternalHost,
    agentInternalPort,
  } = getPlatformEnv();
  if (!token) {
    console.warn(
      '[agent-internal] AGENT_RUNNER_TOKEN is not set; the Agent Runner ' +
        'endpoint is disabled and agent runs cannot be dispatched.',
    );
    return;
  }

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

  server.listen(agentInternalPort, agentInternalHost, () => {
    console.log(
      `[agent-internal] listening on ${agentInternalHost}:${agentInternalPort}`,
    );
  });
  g.__hatchInternalServer__ = { server, port: agentInternalPort };
}
