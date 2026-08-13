import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { auth } from '~auth/server';
import { envEntriesSchema, envRequestIdSchema } from '~agent/protocol';

const MAX_BODY_BYTES = 256 * 1024;
const TOO_LARGE = Symbol('too-large');
const NO_STORE_HEADERS = { 'cache-control': 'no-store' } as const;

const bodySchema = z.strictObject({
  requestId: envRequestIdSchema,
  entries: envEntriesSchema,
});

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: NO_STORE_HEADERS });
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function parseRunId(request: Request): string | null {
  const url = new URL(request.url);
  return url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/env$/)?.[1] ?? null;
}

async function readCappedJson(
  request: Request,
): Promise<unknown | typeof TOO_LARGE> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return TOO_LARGE;

  const body = request.body;
  if (!body) return undefined;

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return TOO_LARGE;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (!text.trim()) return undefined;
  return JSON.parse(text);
}

async function handleAgentRunEnvPost({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return textResponse('Unauthorized', 401);

  const runId = parseRunId(request);
  if (!runId) return textResponse('Not found', 404);
  if (
    request.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase() !== 'application/json'
  ) {
    return textResponse('Unsupported media type', 415);
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    const raw = await readCappedJson(request);
    if (raw === TOO_LARGE) return textResponse('Payload too large', 413);
    parsed = bodySchema.parse(raw);
  } catch {
    return textResponse('Bad request', 400);
  }

  try {
    const { submitAgentEnv } = await import('~server/agent-runs');
    await submitAgentEnv(runId, parsed.requestId, parsed.entries);
    return jsonResponse({ ok: true });
  } catch (error) {
    const { AppError } = await import('~server/errors');
    if (error instanceof AppError) {
      if (error.status === 400) return textResponse('Bad request', 400);
      if (error.status === 409) {
        return textResponse('Environment request is no longer waiting.', 409);
      }
      if (error.status === 502) {
        return textResponse(
          'Agent Runner could not store the environment.',
          502,
        );
      }
      if (error.status === 503) {
        return textResponse('Agent Runner is unavailable.', 503);
      }
      if (error.status === 504) {
        return textResponse(
          'Agent Runner did not confirm environment storage.',
          504,
        );
      }
    }
    return textResponse('Could not submit environment values.', 500);
  }
}

export async function postAgentRunEnv(input: {
  request: Request;
}): Promise<Response> {
  try {
    return await handleAgentRunEnvPost(input);
  } catch {
    // Keep even authentication/runtime failures cache-safe and value-free.
    return textResponse('Could not submit environment values.', 500);
  }
}

export const Route = createFileRoute('/api/agent/runs/$runId/env')({
  server: { handlers: { POST: postAgentRunEnv } },
});
