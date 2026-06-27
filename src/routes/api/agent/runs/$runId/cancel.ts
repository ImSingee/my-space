import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';

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

        const { cancelAgentRun } = await import('~server/agent-runs');
        await cancelAgentRun(runId);
        return Response.json({ ok: true });
      },
    },
  },
});
