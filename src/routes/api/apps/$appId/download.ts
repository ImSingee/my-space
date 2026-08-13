import { createFileRoute } from '@tanstack/react-router';
import { handleDownloadRequest } from '~server/apps/runtime-api/download';

export const handle = handleDownloadRequest;

export const Route = createFileRoute('/api/apps/$appId/download')({
  server: { handlers: { GET: handle } },
});
