import { createFileRoute } from '@tanstack/react-router';
import { handleMobileRequest } from '~server/mobile-api/http';

export const Route = createFileRoute('/api/mobile/v1/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleMobileRequest(request),
      POST: ({ request }) => handleMobileRequest(request),
    },
  },
});
