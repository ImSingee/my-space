import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';
import {
  subscribePlatformEvents,
  type PlatformEvent,
} from '~server/platform-events';

const HEARTBEAT_INTERVAL_MS = 20_000;

function encodeEvent(
  encoder: TextEncoder,
  name: 'resync' | 'platform',
  data: object,
): Uint8Array {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function eventStream(request: Request): Response {
  const encoder = new TextEncoder();
  let closeStream = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener('abort', close);
        try {
          controller.close();
        } catch {
          // The stream may already have been closed by its consumer.
        }
      };
      closeStream = close;

      const enqueue = (chunk: Uint8Array) => {
        if (closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          close();
          return false;
        }
      };

      request.signal.addEventListener('abort', close, { once: true });
      if (request.signal.aborted) {
        close();
        return;
      }

      // The resync is sent on every connection, including reconnects after a
      // process restart. The client uses database truth to recover any event
      // that happened while no in-memory subscription existed.
      if (!enqueue(encodeEvent(encoder, 'resync', {}))) return;
      unsubscribe = subscribePlatformEvents((event: PlatformEvent) => {
        enqueue(encodeEvent(encoder, 'platform', event));
      });

      heartbeat = setInterval(() => {
        enqueue(encoder.encode(': keep-alive\n\n'));
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref?.();
    },
    cancel() {
      closeStream();
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

export async function handle({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response('Unauthorized', { status: 401 });
  return eventStream(request);
}

export const Route = createFileRoute('/api/events')({
  server: { handlers: { GET: handle } },
});
