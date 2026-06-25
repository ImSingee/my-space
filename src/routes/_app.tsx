import { AppShell } from '@mantine/core';
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { Sidebar } from '~components/app-shell/sidebar';
import { fetchSession } from '~server/auth';

export const Route = createFileRoute('/_app')({
  beforeLoad: async () => {
    const session = await fetchSession();
    if (!session) {
      throw redirect({ to: '/login' });
    }
    return { session };
  },
  component: AppLayout,
});

function AppLayout() {
  return (
    <AppShell navbar={{ width: 272, breakpoint: 'sm' }} padding={0}>
      <AppShell.Navbar withBorder>
        <Sidebar />
      </AppShell.Navbar>
      <AppShell.Main style={{ height: '100dvh', overflow: 'hidden' }}>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
