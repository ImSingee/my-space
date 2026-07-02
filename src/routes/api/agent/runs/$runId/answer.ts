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

function parseRunId(request: Request): string | null {
  const url = new URL(request.url);
  return (
    url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/answer$/)?.[1] ?? null
  );
}

export const Route = createFileRoute('/api/agent/runs/$runId/answer')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return new Response('Unauthorized', { status: 401 });

        const runId = parseRunId(request);
        if (!runId) return new Response('Not found', { status: 404 });

        let parsed: z.infer<typeof bodySchema>;
        try {
          parsed = bodySchema.parse(await request.json());
        } catch {
          return new Response('Bad request', { status: 400 });
        }

        const { answerAgentRun } = await import('~server/agent-runs');
        const { errorResponse } = await import('~server/errors');
        try {
          await answerAgentRun(runId, parsed.askId, parsed.answers);
          return Response.json({ ok: true });
        } catch (error) {
          // Answer failures are conflicts by default (run/question no longer
          // waiting); an AppError can carry a more specific status.
          return errorResponse(error, 409);
        }
      },
    },
  },
});
