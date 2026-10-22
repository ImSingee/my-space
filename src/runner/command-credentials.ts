/** Runner-private credential control path; no fleet credential reaches a child. */
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { CommandCredentials } from '~agent/command-credentials';

const credentialSchema = z.object({
  token: z.string().min(1).max(8192).regex(/^\S+$/),
  expiresAt: z.iso.datetime(),
  context: z.object({
    runId: z.string(),
    sessionId: z.string(),
    runnerId: z.string(),
  }),
});
const UNAVAILABLE =
  'Run CLI credentials are unavailable. Retry in a new command.';

export function createCommandCredentials(options: {
  platformUrl: string;
  cliUrl: string;
  fleetToken: string;
  runnerId: string;
  runId: string;
  sessionId: string;
  signal: AbortSignal;
  isConnected: () => boolean;
}): CommandCredentials {
  return {
    async withEnvironment(signal, execute) {
      const lifetime = new AbortController();
      const active = AbortSignal.any(
        [options.signal, signal, lifetime.signal].filter(
          (item): item is AbortSignal => !!item,
        ),
      );
      const secrets = new Set<string>();
      const redact = (value: string) => {
        for (const secret of secrets)
          value = value.replaceAll(secret, '[redacted]');
        return value;
      };
      let issued = 0;
      let inFlight = 0;
      const mint = async () => {
        // Bound memory and control-plane traffic even for a hostile command.
        if (++issued > 1024 || active.aborted || !options.isConnected())
          throw new Error(UNAVAILABLE);
        for (let attempt = 0; attempt < 3; attempt++) {
          if (active.aborted || !options.isConnected())
            throw new Error(UNAVAILABLE);
          try {
            const started = performance.now();
            const response = await fetch(
              `${options.platformUrl}/internal/api/runs/${encodeURIComponent(options.runId)}/token`,
              {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${options.fleetToken}`,
                  'content-type': 'application/json',
                },
                body: JSON.stringify({ runnerId: options.runnerId }),
                signal: AbortSignal.any([active, AbortSignal.timeout(3000)]),
                redirect: 'error',
              },
            );
            // Authorization/binding failures are final; never replay a business RPC.
            if (!response.ok && response.status < 500) {
              await response.body?.cancel();
              throw new Error('denied');
            }
            if (!response.ok) {
              await response.body?.cancel();
              throw new Error('transient');
            }
            const credential = credentialSchema.parse(await response.json());
            const serverTime = Date.parse(response.headers.get('date') ?? '');
            // Use the server clock, allowing one second of Date-header precision.
            if (
              !Number.isFinite(serverTime) ||
              Date.parse(credential.expiresAt) -
                serverTime -
                (performance.now() - started) <
                2000 ||
              credential.context.runId !== options.runId ||
              credential.context.sessionId !== options.sessionId ||
              credential.context.runnerId !== options.runnerId ||
              active.aborted ||
              !options.isConnected()
            )
              throw new Error('denied');
            secrets.add(credential.token);
            return credential;
          } catch (error) {
            if (
              active.aborted ||
              attempt === 2 ||
              (error instanceof Error && error.message === 'denied')
            )
              throw new Error(UNAVAILABLE);
            await delay(200 * (attempt + 1), undefined, {
              signal: active,
            }).catch(() => {
              throw new Error(UNAVAILABLE);
            });
          }
        }
        throw new Error(UNAVAILABLE);
      };

      const initial = await mint();
      const key = randomBytes(32).toString('hex');
      secrets.add(key);
      const server = http.createServer({ maxHeaderSize: 1024 }, (req, res) => {
        res.setHeader('cache-control', 'no-store');
        const supplied = Buffer.from(req.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${key}`);
        if (
          req.method !== 'POST' ||
          req.url !== '/credential' ||
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        ) {
          res.writeHead(403).end();
          return;
        }
        if (active.aborted || inFlight >= 4) {
          res.writeHead(503).end();
          return;
        }
        inFlight++;
        void mint()
          .then((credential) => {
            if (active.aborted) {
              res.destroy();
              return;
            }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ...credential, url: options.cliUrl }));
          })
          .catch(() => res.writeHead(503).end())
          .finally(() => {
            inFlight--;
          });
      });
      server.maxConnections = 16;
      server.maxRequestsPerSocket = 8;
      server.keepAliveTimeout = 1000;
      server.requestTimeout = 5000;
      server.headersTimeout = 5000;
      server.setTimeout(10000, (socket) => socket.destroy());
      const close = () => {
        server.close();
        server.closeAllConnections();
      };
      active.addEventListener('abort', close, { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        if (active.aborted) throw new Error(UNAVAILABLE);
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error(UNAVAILABLE);
        return await execute({
          signal: active,
          env: {
            HATCH_CLI_URL: options.cliUrl,
            HATCH_CLI_TOKEN: initial.token,
            HATCH_CLI_RUN_ENDPOINT: `http://127.0.0.1:${address.port}/credential`,
            HATCH_CLI_RUN_SECRET: key,
          },
          redact,
          stream: (emit) => {
            let pending = '';
            return {
              write: (value) => {
                pending += value;
                const longest = Math.max(
                  ...[...secrets].map((item) => item.length),
                );
                let end = Math.max(0, pending.length - longest + 1);
                for (const secret of secrets) {
                  let index = pending.indexOf(secret);
                  while (index >= 0 && index < end) {
                    end = Math.max(end, index + secret.length);
                    index = pending.indexOf(secret, index + secret.length);
                  }
                }
                if (end) emit(redact(pending.slice(0, end)));
                pending = pending.slice(end);
              },
              flush: () => {
                if (pending) emit(redact(pending));
                pending = '';
              },
            };
          },
        });
      } finally {
        lifetime.abort();
        active.removeEventListener('abort', close);
        close();
        secrets.clear();
      }
    },
  };
}
