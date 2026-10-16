import { createFileRoute } from '@tanstack/react-router';
import { handleAppHandoffRequest } from '~server/app-handoffs';

export const Route = createFileRoute('/api/auth/handoffs/consume')({
  server: {
    handlers: { ANY: ({ request }) => handleAppHandoffRequest(request) },
  },
});
