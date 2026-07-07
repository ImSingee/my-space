import { Box, Text } from '@mantine/core';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import {
  IconPalette,
  IconRobot,
  IconServer2,
  IconServerBolt,
  IconUsers,
} from '@tabler/icons-react';
import { Fragment } from 'react';
import { Page } from '~components/app-shell/page';
import classes from './settings.module.css';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsLayout,
});

const GROUPS = [
  {
    label: null,
    items: [
      { to: '/settings/providers', label: 'AI Providers', icon: IconServer2 },
      { to: '/settings/users', label: 'Users', icon: IconUsers },
      { to: '/settings/appearance', label: 'Appearance', icon: IconPalette },
    ],
  },
  {
    label: 'Status',
    items: [
      { to: '/settings/backends', label: 'Backends', icon: IconServerBolt },
      { to: '/settings/agent-runner', label: 'Agent Runner', icon: IconRobot },
    ],
  },
] as const;

function SettingsLayout() {
  return (
    <Page
      title="Settings"
      description="Manage providers, users, backends, the Agent Runner, and how Hatch looks."
      size={1040}
    >
      <Box className={classes.layout}>
        <Box component="nav" className={classes.nav}>
          {GROUPS.map((group) => (
            <Fragment key={group.label ?? 'general'}>
              {group.label && (
                <Text className={classes.navGroupLabel}>{group.label}</Text>
              )}
              {group.items.map((s) => {
                const Icon = s.icon;
                return (
                  <Link key={s.to} to={s.to} className={classes.navItem}>
                    <Icon
                      size={18}
                      stroke={1.6}
                      className={classes.navItemIcon}
                    />
                    {s.label}
                  </Link>
                );
              })}
            </Fragment>
          ))}
        </Box>

        <Box className={classes.section}>
          <Outlet />
        </Box>
      </Box>
    </Page>
  );
}
