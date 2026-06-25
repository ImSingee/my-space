import { Center, Loader } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';
import { Page } from '~components/app-shell/page';
import { ProvidersPanel } from '~components/settings/providers-panel';
import { providersQueryOptions } from '~queries/agent';

export const Route = createFileRoute('/_app/settings')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(providersQueryOptions),
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <Page
      title="Settings"
      description="Agent providers, models, and platform configuration."
      size={900}
    >
      <Suspense
        fallback={
          <Center py="xl">
            <Loader />
          </Center>
        }
      >
        <ProvidersPanel />
      </Suspense>
    </Page>
  );
}
