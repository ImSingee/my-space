import { createFileRoute } from '@tanstack/react-router';
import { handleUserscriptRequest } from '~server/apps/runtime-api/userscript';

export const handle = handleUserscriptRequest;

export const Route = createFileRoute('/api/apps/$appId/userscripts/$scriptId')({
  server: { handlers: { GET: handle } },
});
