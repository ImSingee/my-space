import { createFileRoute } from '@tanstack/react-router';
import { handlePlatformApiRequest } from '~server/platform-api/http';

export const Route = createFileRoute('/api/rpc/$')({
  server: {
    handlers: { ANY: ({ request }) => handlePlatformApiRequest(request) },
  },
});
