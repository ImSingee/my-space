import { createFileRoute } from '@tanstack/react-router';
import { handleApiKeysRequest } from '~server/api-keys';

export const Route = createFileRoute('/api/settings/api-keys/revoke')({
  server: {
    handlers: { POST: ({ request }) => handleApiKeysRequest(request) },
  },
});
