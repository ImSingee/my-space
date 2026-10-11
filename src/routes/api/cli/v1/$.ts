import { createFileRoute } from '@tanstack/react-router';
import { handleCliApiRequest } from '~server/cli/api';

export const Route = createFileRoute('/api/cli/v1/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleCliApiRequest(request),
      POST: ({ request }) => handleCliApiRequest(request),
    },
  },
});
