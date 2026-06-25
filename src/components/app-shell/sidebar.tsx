import {
  ActionIcon,
  Avatar,
  Box,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouter, useRouterState } from '@tanstack/react-router';
import {
  IconAppWindow,
  IconLayoutDashboard,
  IconLogout,
  IconSparkles,
  IconMoon,
  IconSettings,
  IconStack2,
  IconSun,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import { sidebarItemsQueryOptions } from '~queries/subapps';
import { Brand } from './brand';
import classes from './sidebar.module.css';

function useIsActive() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (to: string) => pathname === to || pathname.startsWith(`${to}/`);
}

function ColorSchemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme('light', {
    getInitialValueInEffect: true,
  });
  const next = computed === 'dark' ? 'light' : 'dark';
  return (
    <Tooltip label={`Switch to ${next} mode`} position="top" withArrow>
      <ActionIcon
        variant="default"
        size="lg"
        radius="md"
        aria-label="Toggle color scheme"
        onClick={() => setColorScheme(next)}
      >
        {computed === 'dark' ? (
          <IconSun size={18} stroke={1.6} />
        ) : (
          <IconMoon size={18} stroke={1.6} />
        )}
      </ActionIcon>
    </Tooltip>
  );
}

function UserMenu() {
  const router = useRouter();
  const { data } = authClient.useSession();
  const email = data?.user.email ?? 'account';
  const name = data?.user.name || email;

  const signOut = async () => {
    await authClient.signOut();
    toast.success('Signed out');
    await router.navigate({ to: '/login' });
  };

  return (
    <Menu position="top-end" width={220} withArrow shadow="md">
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          radius="md"
          aria-label="Account menu"
        >
          <Avatar size={28} radius="xl" name={name} color="violet" />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          <Text size="xs" truncate>
            {email}
          </Text>
        </Menu.Label>
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconLogout size={16} stroke={1.6} />}
          onClick={signOut}
        >
          Sign out
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function PinnedApps() {
  const isActive = useIsActive();
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  if (!pins || pins.length === 0) return null;
  return (
    <>
      <Text size="xs" fw={600} c="dimmed" px="sm" mt="md" mb={4}>
        Pinned apps
      </Text>
      <Stack gap={2} px="xs">
        {pins.map((pin) => (
          <NavLink
            key={pin.id}
            renderRoot={(props) => (
              <Link
                to="/apps/$subappId"
                params={{ subappId: pin.subappId }}
                {...props}
              />
            )}
            label={pin.label}
            leftSection={<IconAppWindow size={18} stroke={1.6} />}
            active={isActive(`/apps/${pin.subappId}`)}
            variant="light"
          />
        ))}
      </Stack>
    </>
  );
}

export function Sidebar() {
  const isActive = useIsActive();

  return (
    <Box className={classes.root}>
      <Box className={classes.head}>
        <Brand />
      </Box>

      <ScrollArea className={classes.nav} type="scroll" scrollbarSize={6}>
        <Stack gap={2} px="xs">
          <NavLink
            renderRoot={(props) => <Link to="/dashboard" {...props} />}
            label="Dashboard"
            leftSection={<IconLayoutDashboard size={18} stroke={1.6} />}
            active={isActive('/dashboard')}
            variant="light"
          />
          <NavLink
            renderRoot={(props) => <Link to="/subapps" {...props} />}
            label="Subapps"
            leftSection={<IconStack2 size={18} stroke={1.6} />}
            active={isActive('/subapps')}
            variant="light"
          />
          <NavLink
            renderRoot={(props) => <Link to="/agent" {...props} />}
            label="Agent"
            leftSection={<IconSparkles size={18} stroke={1.6} />}
            active={isActive('/agent')}
            variant="light"
          />
        </Stack>
        <PinnedApps />
      </ScrollArea>

      <Box className={classes.footer}>
        <NavLink
          renderRoot={(props) => <Link to="/settings" {...props} />}
          label="Settings"
          leftSection={<IconSettings size={18} stroke={1.6} />}
          active={isActive('/settings')}
          variant="light"
          mb="2xs"
        />
        <Group justify="space-between" px="xs">
          <UserMenu />
          <ColorSchemeToggle />
        </Group>
      </Box>
    </Box>
  );
}
