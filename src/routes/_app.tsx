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
import { PlatformEventsProvider } from '~components/system/platform-events';
import { hasActiveSession } from '~server/auth';
import classes from './_app.module.css';

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ location }) => {
    const authenticated = await hasActiveSession();
    if (!authenticated) {
      // Carry the attempted URL so /login can return the user to their deep
      // link after authenticating instead of always landing on /dashboard.
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
    // This guard intentionally receives only a boolean. The Better Auth session
    // token stays in its HttpOnly cookie, while server functions independently
    // enforce authorization through authMiddleware/requireSession. The client
    // reads display-safe user information through authClient.useSession().
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
    <PlatformEventsProvider>
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
    </PlatformEventsProvider>
  );
}
