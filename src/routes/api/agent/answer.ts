import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { auth } from '~auth/server';

const bodySchema = z.object({
  askId: z.string().min(1),
  answers: z.array(
    z.object({
      questionId: z.string().min(1),
      selectedOptionIds: z.array(z.string()).default([]),
      customText: z
        .string()
        .nullish()
        .transform((v) => v ?? undefined),
    }),
  ),
});

export const Route = createFileRoute('/api/agent/answer')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) {
          return new Response('Unauthorized', { status: 401 });
        }

        let parsed;
        try {
          parsed = bodySchema.parse(await request.json());
        } catch {
          return new Response('Bad request', { status: 400 });
        }

        const { submitAnswer } = await import('~agent/ask-registry');
        const delivered = submitAnswer(parsed.askId, parsed.answers);
        if (!delivered) {
          return new Response('Question is no longer waiting.', {
            status: 409,
          });
        }

        return Response.json({ ok: true });
      },
    },
  },
});
