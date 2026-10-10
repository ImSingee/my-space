import { createFileRoute } from '@tanstack/react-router';
import { handleCliAuthRequest } from '~server/cli-auth/http';

export const Route = createFileRoute('/api/cli/v1/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleCliAuthRequest(request),
      POST: ({ request }) => handleCliAuthRequest(request),
    },
  },
});
