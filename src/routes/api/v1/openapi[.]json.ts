import { createFileRoute } from '@tanstack/react-router';
import { generatePlatformOpenApi } from '~server/platform-api/openapi';

export const Route = createFileRoute('/api/v1/openapi.json')({
  server: {
    handlers: {
      GET: async () =>
        Response.json(await generatePlatformOpenApi(), {
          headers: {
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
          },
        }),
    },
  },
});
