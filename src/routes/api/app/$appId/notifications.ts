import { createFileRoute } from '@tanstack/react-router';
import { handleNotificationRequest } from '~server/apps/runtime-api/notifications';

export const Route = createFileRoute('/api/app/$appId/notifications')({
  server: {
    handlers: {
      POST: handleNotificationRequest,
    },
  },
});
