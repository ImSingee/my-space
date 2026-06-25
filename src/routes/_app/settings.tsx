import { Button, Center, Loader } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { IconPlus } from '@tabler/icons-react';
import { Suspense, useState } from 'react';
import { Page } from '~components/app-shell/page';
import {
  ProviderFormModal,
  ProvidersPanel,
} from '~components/settings/providers-panel';
import { providersQueryOptions } from '~queries/agent';

export const Route = createFileRoute('/_app/settings')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(providersQueryOptions),
  component: SettingsPage,
});

function SettingsPage() {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <Page
      title="Settings"
      description="Agent providers, models, and platform configuration."
      size={900}
      actions={
        <Button
          leftSection={<IconPlus size={16} stroke={1.8} />}
          onClick={() => setCreateOpen(true)}
        >
          Add provider
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
        <ProvidersPanel onAddProvider={() => setCreateOpen(true)} />
      </Suspense>

      <ProviderFormModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </Page>
  );
}
