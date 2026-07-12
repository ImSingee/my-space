import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';

function parseAttachmentId(request: Request): string | null {
  const match = new URL(request.url).pathname.match(
    /^\/api\/agent\/attachments\/([^/]+)\/?$/,
  );
  return match ? decodeURIComponent(match[1]) : null;
}

export const Route = createFileRoute('/api/agent/attachments/$attachmentId')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return new Response('Unauthorized', { status: 401 });
        const id = parseAttachmentId(request);
        if (!id) return new Response('Not found', { status: 404 });

        const { attachmentDisposition, getAgentAttachment } =
          await import('~server/agent-attachments');
        const got = await getAgentAttachment(id);
        if (!got) return new Response('Not found', { status: 404 });
        return new Response(Uint8Array.from(got.body).buffer, {
          headers: {
            'content-type': got.attachment.mimeType,
            'content-length': String(got.attachment.size),
            'content-disposition': attachmentDisposition(got.attachment.name),
            'cache-control': 'private, no-store',
          },
        });
      },
    },
  },
});
