import { Stack } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { ApiKeysPanel } from '~components/settings/api-keys-panel';
import { AccountProfilePanel } from '~components/settings/account-profile-panel';
import { ActiveSessionsPanel } from '~components/settings/active-sessions-panel';
import { HomepagePanel } from '~components/settings/homepage-panel';
import { ChangePasswordPanel } from '~components/settings/change-password-panel';
import { PasskeysPanel } from '~components/settings/passkeys-panel';
import { SectionHead } from '~components/settings/section-head';
import { passkeyOriginQueryOptions } from '~queries/passkeys';

export const Route = createFileRoute('/_app/settings/account')({
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(passkeyOriginQueryOptions),
  component: AccountRoute,
});

function AccountRoute() {
  const appOrigin = Route.useLoaderData();
  return (
    <>
      <SectionHead
        title="Account"
        description="Manage your profile and how you sign in to this space."
      />
      <Stack gap="4xl">
        <AccountProfilePanel />
        <HomepagePanel />
        <ChangePasswordPanel />
        <PasskeysPanel appOrigin={appOrigin} />
        <ApiKeysPanel />
        <ActiveSessionsPanel />
      </Stack>
    </>
  );
}
