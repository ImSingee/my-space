import { createFileRoute } from '@tanstack/react-router';
import { handleApiKeysRequest } from '~server/api-keys';

export const Route = createFileRoute('/api/settings/api-keys/')({
  server: {
    handlers: {
      GET: ({ request }) => handleApiKeysRequest(request),
      POST: ({ request }) => handleApiKeysRequest(request),
    },
  },
});
