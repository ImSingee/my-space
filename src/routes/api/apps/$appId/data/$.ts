import { createFileRoute } from '@tanstack/react-router';
import { handleDataRequest } from '~server/apps/runtime-api/data';

export const handle = handleDataRequest;

export const Route = createFileRoute('/api/apps/$appId/data/$')({
  server: { handlers: { GET: handle, POST: handle } },
});
