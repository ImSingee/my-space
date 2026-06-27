import { createFileRoute } from '@tanstack/react-router';
import type { AgentRunStreamEvent } from '~agent/events';
import { auth } from '~auth/server';

function parse(request: Request): { runId: string; after: number } | null {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/events$/);
  if (!match) return null;
  const rawAfter = Number(url.searchParams.get('after') ?? '0');
  return {
    runId: match[1],
    after: Number.isFinite(rawAfter) ? Math.max(0, Math.floor(rawAfter)) : 0,
  };
}

function isTerminalEvent(event: AgentRunStreamEvent): boolean {
  return (
    event.event.type === 'done' ||
    event.event.type === 'error' ||
    event.event.type === 'cancelled'
  );
}

export const Route = createFileRoute('/api/agent/runs/$runId/events')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return new Response('Unauthorized', { status: 401 });

        const parsed = parse(request);
        if (!parsed) return new Response('Not found', { status: 404 });

        const {
          getAgentRun,
          interruptAgentRun,
          isAgentRunLive,
          isTerminalAgentRunStatus,
          listRunEventsAfter,
          subscribeToAgentRun,
        } = await import('~server/agent-runs');

        const run = await getAgentRun(parsed.runId);
        if (!run) return new Response('Not found', { status: 404 });

        const encoder = new TextEncoder();
        let closeStream = () => {};

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let closed = false;
            let lastSeq = parsed.after;
            let unsubscribe = () => {};
            let listeningForAbort = false;

            const close = () => {
              if (closed) return;
              closed = true;
              unsubscribe();
              if (listeningForAbort) {
                request.signal.removeEventListener('abort', close);
              }
              try {
                controller.close();
              } catch {
                // Stream may already be closed by the client.
              }
            };
            closeStream = close;

            const send = (event: AgentRunStreamEvent) => {
              if (closed || event.seq <= lastSeq) return;
              lastSeq = event.seq;
              try {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                );
              } catch {
                close();
                return;
              }
              if (isTerminalEvent(event)) close();
            };

            const replay = async () => {
              const events = await listRunEventsAfter(parsed.runId, lastSeq);
              for (const event of events) send(event);
            };

            try {
              await replay();
              if (closed) return;
              let current = await getAgentRun(parsed.runId);
              if (closed) return;
              if (!current || isTerminalAgentRunStatus(current.status)) {
                close();
                return;
              }

              if (!isAgentRunLive(parsed.runId)) {
                await interruptAgentRun(
                  parsed.runId,
                  'Agent run is no longer active on this server.',
                );
                await replay();
                close();
                return;
              }

              unsubscribe = subscribeToAgentRun(parsed.runId, send);
              await replay();
              if (closed) return;
              current = await getAgentRun(parsed.runId);
              if (closed) return;
              if (!current || isTerminalAgentRunStatus(current.status)) {
                await replay();
                close();
                return;
              }

              request.signal.addEventListener('abort', close);
              listeningForAbort = true;
            } catch (error) {
              if (!closed) {
                try {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        seq: lastSeq + 1,
                        event: {
                          type: 'error',
                          message:
                            error instanceof Error
                              ? error.message
                              : String(error),
                        },
                      })}\n\n`,
                    ),
                  );
                } catch {
                  // Ignore secondary stream errors.
                }
                close();
              }
            }
          },
          cancel() {
            // Disconnecting from the event stream must not cancel the run.
            closeStream();
          },
        });

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
          },
        });
      },
    },
  },
});
