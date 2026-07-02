import { Box, Group, NavLink, ScrollArea, Stack } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconSparkles } from '@tabler/icons-react';
import { Brand } from '../brand';
import { PinnedApps } from './pinned-apps';
import { PinnedDashboards } from './pinned-dashboards';
import { PinnedWorkflows } from './pinned-workflows';
import { useIsActive } from './section';
import { ColorSchemeToggle, UserMenu } from './user-menu';
import classes from './sidebar.module.css';

export function Sidebar() {
  const isActive = useIsActive();

  return (
    <Box className={classes.root}>
      <Box className={classes.head}>
        <Brand />
      </Box>

      <ScrollArea className={classes.nav} type="scroll" scrollbarSize={6}>
        <Stack gap={2} px="xs" mt={4}>
          <NavLink
            renderRoot={(props) => <Link to="/agent" {...props} />}
            label="Agent"
            leftSection={<IconSparkles size={18} stroke={1.6} />}
            active={isActive('/agent')}
            variant="light"
          />
        </Stack>
        <PinnedDashboards />
        <PinnedApps />
        <PinnedWorkflows />
      </ScrollArea>

      <Box className={classes.footer}>
        <Group justify="space-between" px="xs">
          <UserMenu />
          <ColorSchemeToggle />
        </Group>
      </Box>
    </Box>
  );
}
