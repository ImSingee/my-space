import { createFileRoute } from '@tanstack/react-router';
import { authenticateSessionRequest } from '~server/session-http-auth';
import { stopAgentAutoRetry } from '~server/agent-runs';
import { errorResponse } from '~server/errors';

function parseSessionId(request: Request): string | null {
  const match = new URL(request.url).pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/auto-retry\/?$/,
  );
  return match ? decodeURIComponent(match[1]) : null;
}

/** Stop the session's scheduled automatic retry. Idempotent. */
export async function deleteAgentAutoRetry({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await authenticateSessionRequest(request);
  if (session instanceof Response) return session;

  const sessionId = parseSessionId(request);
  if (!sessionId) return new Response('Not found', { status: 404 });

  try {
    await stopAgentAutoRetry(sessionId);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export const Route = createFileRoute(
  '/api/agent/sessions/$sessionId/auto-retry',
)({
  server: {
    handlers: {
      DELETE: deleteAgentAutoRetry,
    },
  },
});
