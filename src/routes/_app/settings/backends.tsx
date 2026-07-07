import { Center, Loader } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';
import { BackendsPanel } from '~components/apps/backends-panel';
import { SectionHead } from '~components/settings/section-head';
import { appBackendsQueryOptions } from '~queries/apps';

export const Route = createFileRoute('/_app/settings/backends')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(appBackendsQueryOptions),
  component: BackendsRoute,
});

function BackendsRoute() {
  return (
    <>
      <SectionHead
        title="Backends"
        description="Live runtime state of every deployed app backend in the current platform process. Start, stop and restart times reset when the platform restarts."
      />
      <Suspense
        fallback={
          <Center py="xl">
            <Loader />
          </Center>
        }
      >
        <BackendsPanel />
      </Suspense>
    </>
  );
}
