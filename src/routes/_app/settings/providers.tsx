import { Button, Center, Loader } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { IconPlus } from '@tabler/icons-react';
import { Suspense, useState } from 'react';
import { SectionHead } from '~components/settings/section-head';
import {
  ProviderFormModal,
  ProvidersPanel,
} from '~components/settings/providers-panel';
import { providersQueryOptions } from '~queries/agent';

export const Route = createFileRoute('/_app/settings/providers')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(providersQueryOptions),
  component: ProvidersRoute,
});

function ProvidersRoute() {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <SectionHead
        title="AI Providers"
        description="Connect model providers so the Agent can build and run apps."
        action={
          <Button
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={() => setCreateOpen(true)}
          >
            Add provider
          </Button>
        }
      />
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
    </>
  );
}
