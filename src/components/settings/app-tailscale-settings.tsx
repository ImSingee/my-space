import { Alert, Button, Select, Skeleton, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { appsQueryOptions } from '~queries/apps';
import { AppTailscaleServicePanel } from './app-tailscale-service-panel';

export function AppTailscaleSettings() {
  const apps = useQuery(appsQueryOptions);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const selectedApp = apps.data?.find((app) => app.id === selectedAppId);

  return (
    <Stack gap="md" component="section">
      <Text fw={600} fz="lg">
        App addresses
      </Text>
      <Text size="sm" c="dimmed">
        Manage independent private HTTPS addresses for your Apps here. Choose an
        App to configure its Service name, advertising and access address.
      </Text>
      {apps.isPending ? (
        <Skeleton height={80} />
      ) : apps.isError ? (
        <Alert color="red" title="Apps unavailable">
          <Stack gap="xs">
            <Text size="sm">Unable to load Apps. Try again.</Text>
            <Button
              type="button"
              variant="subtle"
              onClick={() => void apps.refetch()}
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
          <Select
            label="App"
            placeholder="Choose an App"
            searchable
            clearable
            nothingFoundMessage="No matching Apps"
            value={selectedApp?.id ?? null}
            onChange={setSelectedAppId}
            data={apps.data.map((app) => ({
              value: app.id,
              label: `${app.name} (${app.slug})${app.status === 'archived' ? ' — archived' : ''}`,
            }))}
          />
          {selectedApp && (
            <AppTailscaleServicePanel
              key={selectedApp.id}
              appId={selectedApp.id}
              slug={selectedApp.slug}
            />
          )}
        </>
      )}
    </Stack>
  );
}
