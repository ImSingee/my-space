import { createFileRoute } from '@tanstack/react-router';
import { handleHandoffCompletion } from '~server/handoffs';

export const Route = createFileRoute('/api/auth/handoffs/complete')({
  server: {
    handlers: { ANY: ({ request }) => handleHandoffCompletion(request) },
  },
});
