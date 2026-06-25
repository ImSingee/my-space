import {
  Box,
  Button,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconLayoutGrid, IconSparkles, IconStack2 } from '@tabler/icons-react';
import classes from './empty-state.module.css';

const STARTER_IDEAS = [
  'A daily habit tracker',
  'A reading list',
  'A simple budget tracker',
];

/**
 * Shown when a dashboard has no widgets. For a brand-new account (no apps yet)
 * it becomes a welcome that funnels into building the first app; once apps
 * exist it explains how widgets get here.
 */
export function DashboardEmptyState({ hasApps }: { hasApps: boolean }) {
  if (hasApps) {
    return (
      <Box className={classes.root}>
        <Stack className={classes.inner} align="center" gap="md">
          <ThemeIcon size={56} radius="xl" variant="light" color="gray">
            <IconLayoutGrid size={28} stroke={1.5} />
          </ThemeIcon>
          <Stack gap={6} align="center">
            <Title order={2} className={classes.title}>
              This dashboard is empty
            </Title>
            <Text c="dimmed" ta="center" maw={420}>
              Use <strong>Add widget</strong> above to place a widget from one
              of your apps here, or build something new with the Agent.
            </Text>
          </Stack>
          <Group gap="sm">
            <Button
              component={Link}
              to="/apps"
              variant="default"
              leftSection={<IconStack2 size={16} stroke={1.7} />}
            >
              Browse apps
            </Button>
            <Button
              component={Link}
              to="/agent"
              leftSection={<IconSparkles size={16} stroke={1.7} />}
            >
              Open the Agent
            </Button>
          </Group>
        </Stack>
      </Box>
    );
  }

  return (
    <Box className={classes.root}>
      <Stack className={classes.inner} align="center" gap="lg">
        <ThemeIcon size={56} radius="xl" variant="light" color="ember">
          <IconSparkles size={28} stroke={1.5} />
        </ThemeIcon>
        <Stack gap={8} align="center">
          <Title order={2} className={classes.title}>
            Welcome to Hatch
          </Title>
          <Text c="dimmed" ta="center" maw={440}>
            Describe an app in plain language and the Agent builds and deploys
            it for you. Your apps then live in the sidebar and on dashboards
            like this one.
          </Text>
        </Stack>
        <Button
          component={Link}
          to="/agent"
          size="md"
          leftSection={<IconSparkles size={18} stroke={1.7} />}
        >
          Build your first app
        </Button>
        <Stack gap={6} align="center">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Try starting with
          </Text>
          <Group gap="xs" justify="center">
            {STARTER_IDEAS.map((idea) => (
              <Button
                key={idea}
                renderRoot={(props) => (
                  <Link to="/agent" search={{ prompt: idea }} {...props} />
                )}
                variant="default"
                size="xs"
                radius="xl"
              >
                {idea}
              </Button>
            ))}
          </Group>
        </Stack>
      </Stack>
    </Box>
  );
}
