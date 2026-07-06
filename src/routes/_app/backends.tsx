import { Button, Center, Loader } from '@mantine/core';
import { Link, createFileRoute } from '@tanstack/react-router';
import { IconArrowLeft } from '@tabler/icons-react';
import { Suspense } from 'react';
import { Page } from '~components/app-shell/page';
import { BackendsPanel } from '~components/apps/backends-panel';
import { appBackendsQueryOptions } from '~queries/apps';

// Deliberately NOT nested under /apps/: that namespace is /apps/$appId, where
// a static `backends` segment would shadow a legacy app whose id (or slug —
// the overview route resolves both) happens to be "backends".
export const Route = createFileRoute('/_app/backends')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(appBackendsQueryOptions),
  component: BackendsPage,
});

function BackendsPage() {
  return (
    <Page
      title="Backends"
      description="Live runtime state of every deployed app backend in the current platform process. Start, stop and restart times reset when the platform restarts."
      actions={
        <Button
          component={Link}
          to="/apps"
          variant="default"
          leftSection={<IconArrowLeft size={16} stroke={1.8} />}
        >
          All apps
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
        <BackendsPanel />
      </Suspense>
    </Page>
  );
}
