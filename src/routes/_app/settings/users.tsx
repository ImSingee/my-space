import { Center, Loader } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';
import { SectionHead } from '~components/settings/section-head';
import { UsersPanel } from '~components/settings/users-panel';
import { usersPanelQueryOptions } from '~queries/users';

export const Route = createFileRoute('/_app/settings/users')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(usersPanelQueryOptions),
  component: UsersRoute,
});

function UsersRoute() {
  return (
    <>
      <SectionHead
        title="Users"
        description="Control whether sign-up is open and manage who has access."
      />
      <Suspense
        fallback={
          <Center py="xl">
            <Loader />
          </Center>
        }
      >
        <UsersPanel />
      </Suspense>
    </>
  );
}
