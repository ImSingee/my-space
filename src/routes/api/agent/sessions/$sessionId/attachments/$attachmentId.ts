import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';

function parse(
  request: Request,
): { sessionId: string; attachmentId: string } | null {
  const match = new URL(request.url).pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/attachments\/([^/]+)\/?$/,
  );
  return match
    ? {
        sessionId: decodeURIComponent(match[1]),
        attachmentId: decodeURIComponent(match[2]),
      }
    : null;
}

export const Route = createFileRoute(
  '/api/agent/sessions/$sessionId/attachments/$attachmentId',
)({
  server: {
    handlers: {
      PUT: async ({ request }: { request: Request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return new Response('Unauthorized', { status: 401 });

        const ids = parse(request);
        if (!ids) return new Response('Not found', { status: 404 });
        const encodedName = request.headers.get('x-attachment-name') ?? '';
        let name: string;
        try {
          name = decodeURIComponent(encodedName);
        } catch {
          return new Response('Invalid attachment name', { status: 400 });
        }

        const declared = Number(request.headers.get('content-length'));
        const { errorResponse } = await import('~server/errors');
        try {
          const { uploadAgentAttachment } =
            await import('~server/agent-attachments');
          const attachment = await uploadAgentAttachment({
            id: ids.attachmentId,
            sessionId: ids.sessionId,
            name,
            contentType:
              request.headers.get('content-type') ?? 'application/octet-stream',
            body: request.body,
            ...(Number.isFinite(declared) ? { declaredBytes: declared } : {}),
          });
          return Response.json({ attachment });
        } catch (error) {
          return errorResponse(error, 400);
        }
      },
    },
  },
});
