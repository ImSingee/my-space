import { AppShell, Burger, Group } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  Outlet,
  createFileRoute,
  redirect,
  useRouterState,
} from '@tanstack/react-router';
import { useEffect } from 'react';
import { Brand } from '~components/app-shell/brand';
import { Sidebar } from '~components/app-shell/sidebar';
import { fetchSession } from '~server/auth';
import classes from './_app.module.css';

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ location }) => {
    const session = await fetchSession();
    if (!session) {
      // Carry the attempted URL so /login can return the user to their deep
      // link after authenticating instead of always landing on /dashboard.
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
    // Intentionally return nothing. TanStack Router serializes beforeLoad return
    // values into the SSR-dehydrated match state sent to the client, so returning
    // the Better Auth session would leak its token (which must stay in the
    // HttpOnly cookie). This is a guard only — server functions enforce auth
    // independently via authMiddleware/requireSession, and the client reads user
    // info through authClient.useSession().
  },
  component: AppLayout,
});

function AppLayout() {
  const [opened, { toggle, close }] = useDisclosure(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Collapse the mobile nav overlay whenever navigation occurs.
  useEffect(() => {
    close();
  }, [pathname, close]);

  return (
    <AppShell
      className={classes.shell}
      padding={0}
      navbar={{
        width: 272,
        breakpoint: 'sm',
        collapsed: { mobile: !opened, desktop: false },
      }}
      header={{ height: 56 }}
    >
      <AppShell.Header withBorder className={classes.header}>
        <Group h="100%" px="sm" gap="sm" wrap="nowrap">
          <Burger
            opened={opened}
            onClick={toggle}
            size="sm"
            aria-label="Toggle navigation"
          />
          <Brand />
        </Group>
      </AppShell.Header>
      <AppShell.Navbar withBorder>
        <Sidebar />
      </AppShell.Navbar>
      <AppShell.Main style={{ height: '100dvh', overflow: 'hidden' }}>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
