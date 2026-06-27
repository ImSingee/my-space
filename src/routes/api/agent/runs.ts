import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { auth } from '~auth/server';

const bodySchema = z
  .object({
    sessionId: z.string().min(1),
    userText: z.string().default(''),
    providerId: z.string().nullish(),
    modelId: z.string().nullish(),
    images: z
      .array(
        z.object({
          data: z.string().min(1),
          mimeType: z.string().min(1),
        }),
      )
      .optional(),
  })
  .refine((b) => b.userText.trim().length > 0 || (b.images?.length ?? 0) > 0, {
    message: 'Message must include text or an image.',
  });

export const Route = createFileRoute('/api/agent/runs')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return new Response('Unauthorized', { status: 401 });

        let parsed: z.infer<typeof bodySchema>;
        try {
          parsed = bodySchema.parse(await request.json());
        } catch {
          return new Response('Bad request', { status: 400 });
        }

        const { startAgentRun } = await import('~server/agent-runs');
        try {
          const result = await startAgentRun(parsed);
          return Response.json(result);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const status = message.includes('already has a running') ? 409 : 400;
          return new Response(message, { status });
        }
      },
    },
  },
});
