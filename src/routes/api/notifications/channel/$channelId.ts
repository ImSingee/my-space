import { createFileRoute } from '@tanstack/react-router';
import { handleChannelPush } from '~server/notifications/channel-ingress';

export const Route = createFileRoute('/api/notifications/channel/$channelId')({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        handleChannelPush(request, params.channelId),
    },
  },
});
