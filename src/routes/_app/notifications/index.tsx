import { Button } from '@mantine/core';
import { Link, createFileRoute } from '@tanstack/react-router';
import { IconSettings } from '@tabler/icons-react';
import { Page } from '~components/app-shell/page';
import { NotificationHistory } from '~components/notifications/history-list';
import { useLiveNotifications } from '~components/notifications/use-live-notifications';
import {
  notificationHistoryQueryOptions,
  notificationSourcesQueryOptions,
} from '~queries/notifications';

export const Route = createFileRoute('/_app/notifications/')({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.prefetchInfiniteQuery(
        notificationHistoryQueryOptions({}),
      ),
      context.queryClient.prefetchQuery(notificationSourcesQueryOptions),
    ]);
  },
  component: NotificationsPage,
});

function NotificationsPage() {
  useLiveNotifications();
  return (
    <Page
      title="Notifications"
      description="Everything Apps and Channels pushed, and where each notification was delivered."
      actions={
        <Button
          component={Link}
          to="/settings/notifications"
          variant="default"
          leftSection={<IconSettings size={16} stroke={1.6} />}
        >
          Delivery settings
        </Button>
      }
    >
      <NotificationHistory />
    </Page>
  );
}
