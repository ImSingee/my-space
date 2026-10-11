import { Stack } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { ApiKeysPanel } from '~components/settings/api-keys-panel';
import { PasskeysPanel } from '~components/settings/passkeys-panel';
import { SectionHead } from '~components/settings/section-head';
import { passkeyOriginQueryOptions } from '~queries/passkeys';

export const Route = createFileRoute('/_app/settings/security')({
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(passkeyOriginQueryOptions),
  component: SecurityRoute,
});

function SecurityRoute() {
  const appOrigin = Route.useLoaderData();
  return (
    <>
      <SectionHead
        title="Security"
        description="Manage how you and your tools sign in to this space."
      />
      <Stack gap="4xl">
        <PasskeysPanel appOrigin={appOrigin} />
        <ApiKeysPanel />
      </Stack>
    </>
  );
}
