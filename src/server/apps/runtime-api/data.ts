import { ZodError } from 'zod';
import {
  appCompatibilityRuntimeMessage,
  type AppCompatibility,
} from '~/app-compatibility';
import { auth } from '~auth/server';
import { db } from '~/db';
import {
  DATA_REQUEST_MAX_BYTES,
  mutateDataTable,
  queryDataTable,
} from '~server/apps/data-table/service';
import { subscribeDataChanges } from '~server/apps/data-table/realtime';
import { AppError, errorResponse } from '~server/errors';
import {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  verifyHatchSignature,
} from '~server/secrets';
import { parseAppApiPath } from './path';
import { readDeploymentCompatibility } from '../compatibility';

const DATA_DEPLOYMENT_HEADER = 'x-hatch-data-deployment';

const DATA_CONFLICT_SQLSTATES = new Set(['23503', '23505', '23P01']);
const DATA_INVALID_SQLSTATES = new Set([
  '22001',
  '22003',
  '22007',
  '22008',
  '22P02',
  '23502',
  '23514',
]);

async function readCappedText(
  request: Request,
  max: number,
): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parse(request: Request): { id: string; action: string } | null {
  const url = new URL(request.url);
  const parsed = parseAppApiPath(url.pathname);
  const match = parsed?.rest.match(/^\/data(?:\/(.*))?$/);
  if (!parsed || !match) return null;
  return { id: parsed.id, action: match[1] ?? '' };
}

async function authorize(
  request: Request,
  id: string,
  rawBody: string,
): Promise<boolean> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (session) {
    const origin = request.headers.get('origin');
    if (request.method !== 'GET' && origin) {
      const expected = new URL(request.url).origin;
      if (origin !== expected) return false;
    }
    return true;
  }
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: { signingSecret: true },
  });
  if (!app?.signingSecret) return false;
  return verifyHatchSignature({
    secret: app.signingSecret,
    timestamp: request.headers.get(HATCH_TIMESTAMP_HEADER),
    signature: request.headers.get(HATCH_SIGNATURE_HEADER),
    payload: rawBody,
  });
}

async function liveDataAppState(
  id: string,
  expectedDeploymentId: string,
): Promise<
  | 'missing'
  | 'activating'
  | 'stale'
  | 'live'
  | { state: 'unsupported'; compatibility: AppCompatibility | null }
> {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: {
      status: true,
      currentDeploymentId: true,
      capabilities: true,
      dataActivationId: true,
    },
  });
  if (
    !app ||
    app.status === 'archived' ||
    !app.currentDeploymentId ||
    !app.capabilities?.dataTable
  ) {
    return 'missing';
  }
  if (app.dataActivationId) return 'activating';
  if (expectedDeploymentId !== app.currentDeploymentId) return 'stale';
  const compatibility = await readDeploymentCompatibility(
    app.currentDeploymentId,
  );
  return compatibility?.isSupported
    ? 'live'
    : { state: 'unsupported', compatibility };
}

function eventStream(
  request: Request,
  id: string,
  expectedDeploymentId: string,
): Response {
  const url = new URL(request.url);
  const rawSince = url.searchParams.get('since');
  const since = rawSince === null ? 0 : Number(rawSince);
  if (
    (rawSince !== null && rawSince.trim() === '') ||
    !Number.isSafeInteger(since) ||
    since < 0
  ) {
    return new Response('Invalid Data Table realtime cursor.', { status: 400 });
  }
  const table = url.searchParams.get('table');
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // The client may already have disconnected.
        }
      };
      request.signal.addEventListener('abort', close, { once: true });
      controller.enqueue(encoder.encode(': connected\n\n'));
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, 20_000);
      heartbeat.unref?.();

      void subscribeDataChanges({
        id,
        since,
        table,
        expectedDeploymentId,
        send(event) {
          if (closed) return;
          if ('reset' in event) {
            controller.enqueue(
              encoder.encode(
                `id: ${event.seq}\nevent: reset\ndata: {"reset":true}\n\n`,
              ),
            );
            return;
          }
          controller.enqueue(
            encoder.encode(
              `id: ${event.seq}\nevent: change\ndata: ${JSON.stringify(
                event,
              )}\n\n`,
            ),
          );
        },
        close,
      })
        .then((stop) => {
          if (closed) stop();
          else unsubscribe = stop;
        })
        .catch((error) => {
          if (!closed) controller.error(error);
          close();
        });
    },
    cancel() {
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

function sqlState(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'PostgresError') return;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function dataErrorResponse(error: unknown): Response {
  if (error instanceof AppError) return errorResponse(error);
  if (error instanceof ZodError) {
    return new Response(error.issues[0]?.message ?? 'Invalid data request.', {
      status: 400,
    });
  }
  const code = sqlState(error);
  if (code && DATA_CONFLICT_SQLSTATES.has(code)) {
    return new Response(
      error instanceof Error ? error.message : String(error),
      {
        status: 409,
      },
    );
  }
  if (code && DATA_INVALID_SQLSTATES.has(code)) {
    return new Response(
      error instanceof Error ? error.message : String(error),
      {
        status: 400,
      },
    );
  }
  // Connection failures, timeouts, and other infrastructure errors must stay
  // retryable for the realtime client. It stops permanently on ordinary 4xx.
  return errorResponse(error, 500);
}

export async function handleDataRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const parsed = parse(request);
  if (!parsed) return new Response('Not found', { status: 404 });
  const expectedDeploymentId =
    request.headers.get(DATA_DEPLOYMENT_HEADER) ?? '';
  const state = await liveDataAppState(parsed.id, expectedDeploymentId);
  if (state === 'missing') {
    return new Response('Not found', { status: 404 });
  }
  if (state === 'activating') {
    return new Response('Data Table deployment is being finalized.', {
      status: 503,
      headers: { 'retry-after': '1' },
    });
  }
  if (state === 'stale') {
    return new Response(
      'This Data client belongs to an inactive deployment. Reload or restart it.',
      { status: 409 },
    );
  }
  if (typeof state === 'object' && state.state === 'unsupported') {
    return new Response(appCompatibilityRuntimeMessage(state.compatibility), {
      status: 503,
    });
  }

  const rawBody =
    request.method === 'GET'
      ? ''
      : await readCappedText(request, DATA_REQUEST_MAX_BYTES);
  if (rawBody === null)
    return new Response('Payload too large', { status: 413 });
  if (!(await authorize(request, parsed.id, rawBody))) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    if (request.method === 'GET' && parsed.action === 'events') {
      return eventStream(request, parsed.id, expectedDeploymentId);
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    let body: unknown;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return new Response('Invalid JSON body', { status: 400 });
    }
    if (parsed.action === 'query') {
      return Response.json(
        await queryDataTable(parsed.id, body, { expectedDeploymentId }),
      );
    }
    if (parsed.action === 'mutate') {
      return Response.json(
        await mutateDataTable(parsed.id, body, { expectedDeploymentId }),
      );
    }
    return new Response('Not found', { status: 404 });
  } catch (error) {
    const response = dataErrorResponse(error);
    if (response.status === 503) response.headers.set('retry-after', '1');
    return response;
  }
}
