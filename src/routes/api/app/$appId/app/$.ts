import { createFileRoute } from '@tanstack/react-router';
import { handleAppRequest } from '~server/apps/runtime-api/app';

export const handle = handleAppRequest;

export const Route = createFileRoute('/api/app/$appId/app/$')({
  server: { handlers: { GET: handle } },
});
