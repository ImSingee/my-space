import { createFileRoute } from '@tanstack/react-router';
import { handleHandoffRequest } from '~server/handoffs';

export const Route = createFileRoute('/api/auth/handoffs/consume')({
  server: {
    handlers: { ANY: ({ request }) => handleHandoffRequest(request) },
  },
});
