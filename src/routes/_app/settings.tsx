import { Box } from '@mantine/core';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import {
  IconPalette,
  IconServer2,
  IconServerBolt,
  IconUsers,
} from '@tabler/icons-react';
import { Page } from '~components/app-shell/page';
import classes from './settings.module.css';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsLayout,
});

const SECTIONS = [
  { to: '/settings/providers', label: 'AI Providers', icon: IconServer2 },
  { to: '/settings/users', label: 'Users', icon: IconUsers },
  { to: '/settings/appearance', label: 'Appearance', icon: IconPalette },
  { to: '/settings/backends', label: 'Backends', icon: IconServerBolt },
] as const;

function SettingsLayout() {
  return (
    <Page
      title="Settings"
      description="Manage providers, users, backends, and how Hatch looks."
      size={1040}
    >
      <Box className={classes.layout}>
        <Box component="nav" className={classes.nav}>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <Link key={s.to} to={s.to} className={classes.navItem}>
                <Icon size={18} stroke={1.6} className={classes.navItemIcon} />
                {s.label}
              </Link>
            );
          })}
        </Box>

        <Box className={classes.section}>
          <Outlet />
        </Box>
      </Box>
    </Page>
  );
}
