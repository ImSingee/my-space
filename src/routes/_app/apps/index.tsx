import {
  Button,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { Link, createFileRoute } from '@tanstack/react-router';
import {
  IconPlus,
  IconServerBolt,
  IconSettings,
  IconStack2,
} from '@tabler/icons-react';
import { Page } from '~components/app-shell/page';
import { AppGlyph } from '~components/apps/app-glyph';
import { StatusBadge } from '~components/system/status-badge';
import { formatRelative } from '~lib/format';
import { listApps } from '~server/apps';
import classes from './apps.module.css';

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
        <>
          <Button
            component={Link}
            to="/backends"
            variant="default"
            leftSection={<IconServerBolt size={16} stroke={1.8} />}
          >
            Backends
          </Button>
          <Button
            component={Link}
            to="/agent"
            leftSection={<IconPlus size={16} stroke={1.8} />}
          >
            New app
          </Button>
        </>
      }
    >
      {apps.length === 0 ? (
        <Stack align="center" gap="xs" py={80} px="md">
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
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {apps.map((app) => (
            <Card
              key={app.id}
              padding="lg"
              radius="lg"
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
                  <Text
                    fw={600}
                    truncate
                    renderRoot={(props) => (
                      <Link
                        to="/apps/$appId"
                        params={{ appId: app.id }}
                        {...props}
                        className={[props.className, classes.primaryLink]
                          .filter(Boolean)
                          .join(' ')}
                      />
                    )}
                  >
                    {app.name}
                  </Text>
                </Group>
                <StatusBadge status={app.status} />
              </Group>
              <Text size="sm" c="dimmed" mt="sm" lineClamp={2}>
                {app.description || 'No description yet.'}
              </Text>
              <Group justify="space-between" align="center" mt="auto" pt="md">
                <Text size="xs" c="dimmed">
                  Updated {formatRelative(app.updatedAt)}
                </Text>
                <Tooltip label="Manage app" position="top" withArrow>
                  <Button
                    renderRoot={(props) => (
                      <Link
                        to="/apps/$appId/manage"
                        params={{ appId: app.id }}
                        {...props}
                      />
                    )}
                    variant="subtle"
                    color="gray"
                    size="compact-sm"
                    className={classes.cardAction}
                    leftSection={<IconSettings size={15} stroke={1.7} />}
                  >
                    Manage
                  </Button>
                </Tooltip>
              </Group>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Page>
  );
}
