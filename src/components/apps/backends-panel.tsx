import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { IconServerBolt, IconSettings } from '@tabler/icons-react';
import { AppGlyph } from '~components/apps/app-glyph';
import {
  BackendControls,
  BackendStatus,
  BackendTime,
  backendLastExitLabel,
} from '~components/apps/backend-controls';
import { appBackendsQueryOptions } from '~queries/apps';
import type { AppBackendView } from '~server/apps';

export function BackendsPanel() {
  const { data: backends } = useSuspenseQuery(appBackendsQueryOptions);

  if (backends.length === 0) {
    return (
      <Stack align="center" gap="xs" py={80} px="md">
        <ThemeIcon size={52} radius="xl" variant="light" color="ember">
          <IconServerBolt size={26} stroke={1.5} />
        </ThemeIcon>
        <Text fw={600} mt="xs">
          No app backends
        </Text>
        <Text size="sm" c="dimmed" ta="center" maw={440}>
          No deployed app declares a backend right now. Deploy an app with the
          backend capability and it will show up here.
        </Text>
        <Button component={Link} to="/apps" mt="md" variant="default">
          Back to Apps
        </Button>
      </Stack>
    );
  }

  return (
    <Table.ScrollContainer minWidth={1080}>
      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>App</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Mode</Table.Th>
            <Table.Th>PID / Port</Table.Th>
            <Table.Th>Started</Table.Th>
            <Table.Th>Last stopped</Table.Th>
            <Table.Th>Last exit</Table.Th>
            <Table.Th w={150} aria-label="Actions" />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {backends.map((backend) => (
            <BackendRow key={backend.id} backend={backend} />
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function BackendRow({ backend }: { backend: AppBackendView }) {
  const { runtime } = backend;
  const running = runtime.state === 'running';

  return (
    <Table.Tr>
      <Table.Td>
        <Group gap="sm" wrap="nowrap">
          <AppGlyph name={backend.name} seed={backend.id} />
          <Stack gap={0} miw={0}>
            <Text
              size="sm"
              fw={600}
              truncate
              renderRoot={(props) => (
                <Link
                  to="/apps/$appId/manage"
                  params={{ appId: backend.id }}
                  {...props}
                />
              )}
            >
              {backend.name}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {backend.slug}
            </Text>
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td>
        <BackendStatus runtime={runtime} />
      </Table.Td>
      <Table.Td>
        <Badge
          size="sm"
          variant="light"
          color={backend.mode === 'long-running' ? 'ember' : 'gray'}
        >
          {backend.mode}
        </Badge>
      </Table.Td>
      <Table.Td>
        {running && runtime.pid != null ? (
          <Text size="sm" ff="monospace">
            {runtime.pid} · :{runtime.port}
          </Text>
        ) : (
          <Text size="sm" c="dimmed">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <BackendTime value={runtime.startedAt} />
      </Table.Td>
      <Table.Td>
        <BackendTime value={runtime.stoppedAt} />
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed" ff="monospace">
          {backendLastExitLabel(runtime)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap" justify="flex-end">
          <BackendControls
            appId={backend.id}
            runtime={runtime}
            name={backend.name}
          />
          <Tooltip label="Manage app" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              renderRoot={(props) => (
                <Link
                  to="/apps/$appId/manage"
                  params={{ appId: backend.id }}
                  {...props}
                />
              )}
              aria-label={`Manage ${backend.name}`}
            >
              <IconSettings size={16} stroke={1.8} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}
