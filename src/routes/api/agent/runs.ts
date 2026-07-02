import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { auth } from '~auth/server';

/** ~25 MB: comfortably fits the composer's downscaled images plus prose. */
const MAX_BODY_BYTES = 25_000_000;
/** Matches the composer's MAX_ATTACHMENTS. */
const MAX_IMAGES = 6;
/** Per-image base64 length cap (~6 MB decoded). */
const MAX_IMAGE_CHARS = 8_000_000;
/** Generous prose cap that still blocks pathological text bodies. */
const MAX_USER_TEXT = 100_000;
const ALLOWED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const TOO_LARGE = Symbol('too-large');

/**
 * Read and JSON-parse the body while enforcing a hard byte cap. `request.json()`
 * buffers the entire body before any validation runs, so a large (or lying
 * Content-Length) request could exhaust memory; this rejects early on the
 * declared size and again while streaming so the cap can't be bypassed.
 */
async function readCappedJson(
  request: Request,
  max: number,
): Promise<unknown | typeof TOO_LARGE> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return TOO_LARGE;

  const body = request.body;
  if (!body) return undefined;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return TOO_LARGE;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (!text.trim()) return undefined;
  return JSON.parse(text);
}

const bodySchema = z
  .object({
    sessionId: z.string().min(1),
    userText: z.string().max(MAX_USER_TEXT).default(''),
    providerId: z.string().nullish(),
    modelId: z.string().nullish(),
    images: z
      .array(
        z.object({
          data: z.string().min(1).max(MAX_IMAGE_CHARS),
          mimeType: z.string().refine((m) => ALLOWED_IMAGE_MIME.has(m), {
            message: 'Unsupported image type.',
          }),
        }),
      )
      .max(MAX_IMAGES)
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
          const raw = await readCappedJson(request, MAX_BODY_BYTES);
          if (raw === TOO_LARGE) {
            return new Response('Payload too large', { status: 413 });
          }
          parsed = bodySchema.parse(raw);
        } catch {
          return new Response('Bad request', { status: 400 });
        }

        const { startAgentRun } = await import('~server/agent-runs');
        const { errorResponse } = await import('~server/errors');
        try {
          const result = await startAgentRun(parsed);
          return Response.json(result);
        } catch (error) {
          // AppError carries its own status (409 for an already-running turn,
          // 404 for a missing session); anything untagged is a bad request.
          return errorResponse(error, 400);
        }
      },
    },
  },
});
