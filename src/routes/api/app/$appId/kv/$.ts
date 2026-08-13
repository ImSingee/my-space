import { createFileRoute } from '@tanstack/react-router';
import { handleKvRequest } from '~server/apps/runtime-api/kv';

export const handle = handleKvRequest;

export const Route = createFileRoute('/api/app/$appId/kv/$')({
  server: {
    handlers: {
      GET: handle,
      PUT: handle,
      POST: handle,
      DELETE: handle,
    },
  },
});
