import {
  Button,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { Link, createFileRoute } from '@tanstack/react-router';
import { IconPlus, IconStack2 } from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Page } from '~components/app-shell/page';
import { AppGlyph } from '~components/apps/app-glyph';
import { StatusBadge } from '~components/apps/status-badge';
import { listApps } from '~server/apps';
import classes from './apps.module.css';

dayjs.extend(relativeTime);

export const Route = createFileRoute('/_app/apps/')({
  loader: () => listApps(),
  component: AppsPage,
});

function AppsPage() {
  const apps = Route.useLoaderData();

  return (
    <Page
      title="Apps"
      description="Independent apps the Agent has created for you."
      actions={
        <Button
          component={Link}
          to="/agent"
          leftSection={<IconPlus size={16} stroke={1.8} />}
        >
          New app
        </Button>
      }
    >
      {apps.length === 0 ? (
        <Card withBorder padding={0} className={classes.empty}>
          <Stack align="center" gap="xs" py={64} px="md">
            <ThemeIcon size={52} radius="xl" variant="light" color="ember">
              <IconStack2 size={26} stroke={1.5} />
            </ThemeIcon>
            <Text fw={600} mt="xs">
              No apps yet
            </Text>
            <Text size="sm" c="dimmed" ta="center" maw={440}>
              Open the Agent and describe what you want — a tracker, a CRM, a
              dashboard — and it will scaffold, build, and deploy it here.
            </Text>
            <Button
              component={Link}
              to="/agent"
              mt="md"
              leftSection={<IconPlus size={16} stroke={1.8} />}
            >
              Build your first app
            </Button>
          </Stack>
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {apps.map((app) => (
            <Card
              key={app.id}
              renderRoot={(props) => (
                <Link
                  to="/apps/$appId/manage"
                  params={{ appId: app.id }}
                  {...props}
                />
              )}
              withBorder
              padding="lg"
              className={classes.card}
            >
              <Group
                justify="space-between"
                wrap="nowrap"
                align="flex-start"
                gap="sm"
              >
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                  <AppGlyph name={app.name} seed={app.id} />
                  <Text fw={600} truncate>
                    {app.name}
                  </Text>
                </Group>
                <StatusBadge status={app.status} />
              </Group>
              <Text size="sm" c="dimmed" mt="sm" lineClamp={2}>
                {app.description || 'No description yet.'}
              </Text>
              <Text size="xs" c="dimmed" mt="auto" pt="md">
                Updated {dayjs(app.updatedAt).fromNow()}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Page>
  );
}
