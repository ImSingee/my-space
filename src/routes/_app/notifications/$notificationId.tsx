import { Button, Center, Loader } from '@mantine/core';
import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { IconArrowLeft } from '@tabler/icons-react';
import { Suspense } from 'react';
import { Page } from '~components/app-shell/page';
import { NotificationDetail } from '~components/notifications/notification-detail';
import { useLiveNotifications } from '~components/notifications/use-live-notifications';
import { notificationDetailQueryOptions } from '~queries/notifications';

export const Route = createFileRoute('/_app/notifications/$notificationId')({
  loader: async ({ context, params }) => {
    try {
      return await context.queryClient.ensureQueryData(
        notificationDetailQueryOptions(params.notificationId),
      );
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        throw notFound();
      }
      throw error;
    }
  },
  component: NotificationDetailPage,
});

function NotificationDetailPage() {
  const notification = Route.useLoaderData();
  const { notificationId } = Route.useParams();
  useLiveNotifications();
  return (
    <Page
      title={notification.title}
      description={`${notification.kindName} from ${notification.sourceName}`}
      size={960}
      actions={
        <Button
          component={Link}
          to="/notifications"
          variant="default"
          leftSection={<IconArrowLeft size={16} stroke={1.6} />}
        >
          All notifications
        </Button>
      }
    >
      <Suspense
        fallback={
          <Center py="xl">
            <Loader />
          </Center>
        }
      >
        <NotificationDetail id={notificationId} />
      </Suspense>
    </Page>
  );
}
