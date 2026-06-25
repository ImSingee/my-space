import { createFileRoute, redirect } from '@tanstack/react-router';
import { dashboardsQueryOptions } from '~queries/subapps';

export const Route = createFileRoute('/_app/dashboard/')({
  loader: async ({ context }) => {
    const dashboards = await context.queryClient.ensureQueryData(
      dashboardsQueryOptions,
    );
    const first = dashboards[0]?.id ?? 'default';
    throw redirect({
      to: '/dashboard/$dashboardId',
      params: { dashboardId: first },
    });
  },
});
