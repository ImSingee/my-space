import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';
import { cancelAgentRun } from '~server/agent-runs';
import { errorResponse } from '~server/errors';

function parseRunId(request: Request): string | null {
  const url = new URL(request.url);
  return (
    url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/cancel$/)?.[1] ?? null
  );
}

export const Route = createFileRoute('/api/agent/runs/$runId/cancel')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return new Response('Unauthorized', { status: 401 });

        const runId = parseRunId(request);
        if (!runId) return new Response('Not found', { status: 404 });

        try {
          await cancelAgentRun(runId);
          return Response.json({ ok: true });
        } catch (error) {
          // A cancel racing the run's own event writes can surface a transient
          // DB error; the client refetches regardless, so map it to a status
          // instead of a raw 500 (and don't wedge deleteSession, which cancels
          // first).
          return errorResponse(error, 500);
        }
      },
    },
  },
});
