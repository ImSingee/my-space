import { Divider, Stack } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { AppTailscaleSettings } from '~components/settings/app-tailscale-settings';
import { SectionHead } from '~components/settings/section-head';
import { TailscaleSettings } from '~components/settings/tailscale-panel';
import { tailscaleQueryOptions } from '~queries/tailscale';

export const Route = createFileRoute('/_app/settings/tailscale')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(tailscaleQueryOptions),
  component: () => (
    <>
      <SectionHead
        title="Tailscale"
        description="Connect this space and manage private App addresses."
      />
      <Stack gap="xl">
        <TailscaleSettings />
        <Divider />
        <AppTailscaleSettings />
      </Stack>
    </>
  ),
});
