import { createFileRoute } from '@tanstack/react-router';
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
        description="Manage the sign-in methods linked to your account."
      />
      <PasskeysPanel appOrigin={appOrigin} />
    </>
  );
}
