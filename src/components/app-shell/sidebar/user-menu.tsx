import {
  ActionIcon,
  Avatar,
  Menu,
  Text,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { Link, useRouter } from '@tanstack/react-router';
import {
  IconAppWindow,
  IconLayoutDashboard,
  IconLogout,
  IconMoon,
  IconSettings,
  IconSun,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';

export function ColorSchemeToggle() {
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

export function UserMenu() {
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
    <Menu
      position="top-end"
      width={220}
      withArrow
      shadow="md"
      trigger="click-hover"
      openDelay={100}
      closeDelay={200}
    >
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          radius="md"
          aria-label="Account menu"
        >
          <Avatar size={28} radius="xl" name={name} />
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
          leftSection={<IconLayoutDashboard size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/dashboards" {...props} />}
        >
          Dashboards
        </Menu.Item>
        <Menu.Item
          leftSection={<IconAppWindow size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/apps" {...props} />}
        >
          Apps
        </Menu.Item>
        <Menu.Item
          leftSection={<IconSettings size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/settings" {...props} />}
        >
          Settings
        </Menu.Item>
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
