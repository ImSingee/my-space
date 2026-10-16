import { createFileRoute } from '@tanstack/react-router';

// Unknown API URLs must not return the global SPA shell as a successful API call.
export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      ANY: () =>
        Response.json(
          { code: 'NOT_FOUND', message: 'Resource not found.' },
          {
            status: 404,
            headers: {
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
              'x-content-type-options': 'nosniff',
            },
          },
        ),
    },
  },
});
