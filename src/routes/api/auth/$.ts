import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const response = await auth.handler(request);
        response.headers.set('cache-control', 'no-store');
        return response;
      },
      POST: async ({ request }: { request: Request }) => {
        const response = await auth.handler(request);
        response.headers.set('cache-control', 'no-store');
        return response;
      },
    },
  },
});
