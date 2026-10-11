import {
  Alert,
  Anchor,
  Button,
  Divider,
  Group,
  Stack,
  Text,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import copy from 'copy-to-clipboard';
import { toast } from 'sonner';
import { appTailscaleQueryOptions } from '~queries/app-tailscale';
import { appTailscaleAddress, AppTailscaleBadge } from './app-tailscale-status';

export function AppTailscaleServiceSection({ appId }: { appId: string }) {
  const query = useQuery(appTailscaleQueryOptions(appId));
  const status = query.data;
  if (!status?.config?.enabled) return null;
  const address = appTailscaleAddress(status);
  const ready = !query.isError && status.state === 'ready' && status.origin;
  return (
    <>
      <Stack component="section" aria-label="Tailscale Service" gap="sm">
        <Group justify="space-between">
          <Text fw={600} fz="lg">
            Tailscale Service
          </Text>
          {!query.isError && <AppTailscaleBadge state={status.state} />}
        </Group>
        <Text size="sm">Service: {status.config.serviceName}</Text>
        {address && (
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
            {address}/
          </Text>
        )}
        {query.isError ? (
          <Alert color="red">Unable to refresh the Service status.</Alert>
        ) : status.message ? (
          <Alert color={status.state === 'error' ? 'red' : 'blue'}>
            {status.message}
          </Alert>
        ) : null}
        <Group>
          {ready && (
            <>
              <Button
                type="button"
                component="a"
                href={status.origin + '/'}
                target="_blank"
                rel="noreferrer"
              >
                Open via Tailscale
              </Button>
              <Button
                type="button"
                variant="default"
                onClick={() => {
                  copy(status.origin + '/');
                  toast.success('Address copied');
                }}
              >
                Copy address
              </Button>
            </>
          )}
          <Anchor component={Link} to="/settings/tailscale" size="sm">
            Manage in Tailscale settings
          </Anchor>
        </Group>
      </Stack>
      <Divider />
    </>
  );
}
