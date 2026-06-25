import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import type { AgentStreamEvent } from '~agent/events';
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

export const Route = createFileRoute('/api/agent/stream')({
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

        const { runAgentTurn } = await import('~agent/runtime');
        const encoder = new TextEncoder();

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let closed = false;
            const emit = (event: AgentStreamEvent) => {
              if (closed) return;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
              );
            };
            const close = () => {
              if (closed) return;
              closed = true;
              try {
                controller.close();
              } catch {
                // stream already torn down
              }
            };

            runAgentTurn({
              sessionId: parsed.sessionId,
              userText: parsed.userText,
              images: parsed.images,
              providerId: parsed.providerId,
              modelId: parsed.modelId,
              signal: request.signal,
              emit,
            })
              .catch((error: unknown) => {
                emit({
                  type: 'error',
                  message:
                    error instanceof Error ? error.message : String(error),
                });
              })
              .finally(close);
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
