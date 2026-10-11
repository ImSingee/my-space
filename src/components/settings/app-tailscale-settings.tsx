import {
  Alert,
  Anchor,
  Button,
  Modal,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { appsQueryOptions } from '~queries/apps';
import { appTailscaleStatusesQueryOptions } from '~queries/app-tailscale';
import {
  appTailscaleAddress,
  AppTailscaleBadge,
} from '~components/apps/app-tailscale-status';
import { AppTailscaleServicePanel } from './app-tailscale-service-panel';

export function AppTailscaleSettings() {
  const apps = useQuery(appsQueryOptions);
  const services = useQuery(appTailscaleStatusesQueryOptions);
  const [search, setSearch] = useState('');
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const selectedApp = apps.data?.find((app) => app.id === selectedAppId);
  const states = new Map(
    services.data?.map((entry) => [entry.appId, entry.status]),
  );
  const needle = search.trim().toLowerCase();
  const filtered = apps.data?.filter((app) =>
    `${app.name} ${app.slug}`.toLowerCase().includes(needle),
  );
  return (
    <Stack gap="md" component="section">
      <Text fw={600} fz="lg">
        App addresses
      </Text>
      <Text size="sm" c="dimmed">
        Manage private HTTPS addresses for your Apps. Configure a Service here;
        its status shows whether the address is ready to open.
      </Text>
      {apps.isPending || services.isPending ? (
        <Skeleton height={120} />
      ) : apps.isError || services.isError ? (
        <Alert color="red" title="App addresses unavailable">
          <Stack gap="xs">
            <Text size="sm">Unable to load App addresses. Try again.</Text>
            <Button
              type="button"
              variant="subtle"
              onClick={() => {
                void apps.refetch();
                void services.refetch();
              }}
            >
              Retry
            </Button>
          </Stack>
        </Alert>
      ) : !apps.data?.length ? (
        <Text size="sm" c="dimmed">
          Create an App to configure its private address.
        </Text>
      ) : (
        <>
          <TextInput
            label="Search Apps"
            placeholder="Name or slug"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
          <Table.ScrollContainer minWidth={650} type="native">
            <Table verticalSpacing="sm" aria-label="App Tailscale addresses">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>App</Table.Th>
                  <Table.Th>Advertise address</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {filtered?.map((app) => {
                  const status = states.get(app.id);
                  const address = status && appTailscaleAddress(status);
                  return (
                    <Table.Tr key={app.id}>
                      <Table.Td>
                        <Text size="sm" fw={500}>
                          {app.name}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {app.slug}
                          {app.status === 'archived' ? ' · archived' : ''}
                        </Text>
                      </Table.Td>
                      <Table.Td
                        style={{ maxWidth: 330, overflowWrap: 'anywhere' }}
                      >
                        {status?.state === 'ready' && address ? (
                          <Anchor
                            href={address + '/'}
                            target="_blank"
                            rel="noreferrer"
                            size="sm"
                          >
                            {address}/
                          </Anchor>
                        ) : (
                          <Text size="sm" c={address ? undefined : 'dimmed'}>
                            {address ? address + '/' : '—'}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <AppTailscaleBadge
                          state={status?.state ?? 'disabled'}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Button
                          type="button"
                          variant="default"
                          size="xs"
                          aria-label={`Configure ${app.name}`}
                          onClick={() => setSelectedAppId(app.id)}
                        >
                          Configure
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
                {!filtered?.length && (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <Text size="sm" c="dimmed">
                        No matching Apps.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </>
      )}
      <Modal
        opened={Boolean(selectedApp)}
        onClose={() => setSelectedAppId(null)}
        title={`Configure ${selectedApp?.name ?? 'App'}`}
        size="lg"
        closeButtonProps={{ 'aria-label': 'Close configuration' }}
      >
        {selectedApp && (
          <AppTailscaleServicePanel
            key={selectedApp.id}
            appId={selectedApp.id}
            slug={selectedApp.slug}
          />
        )}
      </Modal>
    </Stack>
  );
}
