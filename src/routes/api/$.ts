import { ORPCError } from '@orpc/server';
import { createFileRoute } from '@tanstack/react-router';

// Unknown API URLs must not return the global SPA shell as a successful API call.
export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      ANY: () =>
        Response.json(new ORPCError('NOT_FOUND').toJSON(), {
          status: 404,
          headers: {
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
          },
        }),
    },
  },
});
