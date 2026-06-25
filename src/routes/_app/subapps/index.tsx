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
import { StatusBadge } from '~components/subapps/status-badge';
import { listSubapps } from '~server/subapps';
import classes from './subapps.module.css';

dayjs.extend(relativeTime);

export const Route = createFileRoute('/_app/subapps/')({
  loader: () => listSubapps(),
  component: SubappsPage,
});

function SubappsPage() {
  const subapps = Route.useLoaderData();

  return (
    <Page
      title="Subapps"
      description="Independent apps the Agent has created for you."
      actions={
        <Button
          component={Link}
          to="/agent"
          leftSection={<IconPlus size={16} stroke={1.8} />}
        >
          New subapp
        </Button>
      }
    >
      {subapps.length === 0 ? (
        <Card withBorder padding={0} className={classes.empty}>
          <Stack align="center" gap="xs" py={64} px="md">
            <ThemeIcon size={52} radius="xl" variant="light" color="violet">
              <IconStack2 size={26} stroke={1.5} />
            </ThemeIcon>
            <Text fw={600} mt="xs">
              No subapps yet
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
              Build your first subapp
            </Button>
          </Stack>
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {subapps.map((subapp) => (
            <Card
              key={subapp.id}
              renderRoot={(props) => (
                <Link
                  to="/subapps/$subappId"
                  params={{ subappId: subapp.id }}
                  {...props}
                />
              )}
              withBorder
              padding="lg"
              className={classes.card}
            >
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Text fw={600} truncate>
                  {subapp.name}
                </Text>
                <StatusBadge status={subapp.status} />
              </Group>
              <Text size="sm" c="dimmed" mt={6} lineClamp={2}>
                {subapp.description || 'No description yet.'}
              </Text>
              <Text size="xs" c="dimmed" mt="md">
                Updated {dayjs(subapp.updatedAt).fromNow()}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Page>
  );
}
