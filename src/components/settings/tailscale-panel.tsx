import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Divider,
  Group,
  Skeleton,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconCopy, IconExternalLink } from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { tailscaleQueryOptions } from '~queries/tailscale';
import { configureTailscale } from '~server/tailscale';
import {
  tailscaleConfigSchema,
  tailscaleLoginUrlSchema,
  type TailscaleConfig,
  type TailscaleStatus,
} from '~/tailscale';
import { openTailscaleAuthorization } from './tailscale-authorization';

const STATE_LABELS = {
  disconnected: 'Disconnected',
  starting: 'Connecting',
  'needs-login': 'Authorizing',
  'needs-approval': 'Waiting for device approval',
  connected: 'Connected',
  error: 'Needs attention',
} as const;

export function TailscaleSettings() {
  const queryClient = useQueryClient();
  const query = useQuery(tailscaleQueryOptions);
  const mutation = useMutation({
    onMutate: () =>
      queryClient.cancelQueries({ queryKey: tailscaleQueryOptions.queryKey }),
    mutationFn: (config: TailscaleConfig) =>
      configureTailscale({ data: config }),
    onSuccess: (status) => {
      queryClient.setQueryData(tailscaleQueryOptions.queryKey, status);
    },
  });
  if (!query.data) {
    if (!query.error) return <Skeleton height={180} />;
    return (
      <Alert color="red" title="Connection status unavailable">
        <Text size="sm">
          {query.error?.message ?? 'Loading connection status…'}
        </Text>
        <Button
          type="button"
          variant="subtle"
          onClick={() => void query.refetch()}
          loading={query.isFetching}
        >
          Retry
        </Button>
      </Alert>
    );
  }
  return (
    <TailscalePanel
      status={query.data}
      pending={mutation.isPending}
      error={mutation.error?.message ?? query.error?.message ?? null}
      onConfigure={(config) => mutation.mutateAsync(config)}
    />
  );
}

export function TailscalePanel({
  status,
  pending,
  error,
  onConfigure,
}: {
  status: TailscaleStatus;
  pending: boolean;
  error: string | null;
  onConfigure: (config: TailscaleConfig) => Promise<TailscaleStatus>;
}) {
  const [hostname, setHostname] = useState<string | null>(null);
  const [copiedOrigin, setCopiedOrigin] = useState<string | null>(null);
  const authorization = useRef<{
    popup: Window | null;
    ready: boolean;
    navigated: boolean;
  } | null>(null);
  const finishAuthorization = useCallback(() => {
    authorization.current?.popup?.close();
    authorization.current = null;
  }, []);
  const syncAuthorization = useCallback(
    (next: TailscaleStatus) => {
      const attempt = authorization.current;
      if (!attempt?.ready) return;
      if (next.state === 'needs-login') {
        if (
          !attempt.navigated &&
          attempt.popup &&
          !attempt.popup.closed &&
          tailscaleLoginUrlSchema.safeParse(next.loginUrl).success
        ) {
          try {
            attempt.popup.location.replace(next.loginUrl!);
            attempt.navigated = true;
          } catch {
            // The user can continue through the normal link if navigation is
            // blocked by the browser or its cross-origin window policy.
            attempt.popup.close();
            attempt.popup = null;
          }
        }
      } else if (next.state !== 'starting') {
        finishAuthorization();
      }
    },
    [finishAuthorization],
  );
  useEffect(() => syncAuthorization(status), [status, syncAuthorization]);
  useEffect(() => {
    if (error && !pending) finishAuthorization();
  }, [error, pending, finishAuthorization]);
  useEffect(
    () => () => {
      // Do not interrupt an authorization already handed to Tailscale when
      // the user navigates away from Settings.
      const attempt = authorization.current;
      if (attempt && !attempt.navigated) attempt.popup?.close();
      authorization.current = null;
    },
    [],
  );
  const connect = async (deviceName: string) => {
    if (pending || authorization.current || !status.available) return;
    const attempt = {
      popup: openTailscaleAuthorization(),
      ready: false,
      navigated: false,
    };
    authorization.current = attempt;
    try {
      const next = await onConfigure({ enabled: true, hostname: deviceName });
      if (authorization.current !== attempt) return;
      attempt.ready = true;
      syncAuthorization(next);
    } catch {
      if (authorization.current === attempt) finishAuthorization();
    }
  };
  const name = status.enabled ? status.hostname : (hostname ?? status.hostname);
  const validName =
    tailscaleConfigSchema.shape.hostname.safeParse(name).success;
  const disconnect = () => {
    const apply = () => {
      finishAuthorization();
      void onConfigure({ enabled: false, hostname: status.hostname }).catch(
        () => {},
      );
    };
    if (window.location.origin !== status.origin) {
      apply();
      return;
    }
    modals.openConfirmModal({
      title: 'Disconnect this address?',
      children: (
        <Text size="sm">
          You are using the Tailscale address. Disconnecting will close this
          connection. Open Hatch at its original address to reconnect.
        </Text>
      ),
      labels: { confirm: 'Disconnect', cancel: 'Keep connected' },
      confirmProps: { color: 'red' },
      onConfirm: apply,
    });
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Text fw={600}>Private access</Text>
          <Text size="sm" c="dimmed" maw={560}>
            Open Hatch from your devices on Tailscale. Access follows your
            tailnet rules, and visitors still sign in to Hatch.
          </Text>
        </Stack>
        <Badge
          variant="light"
          color={
            status.state === 'connected'
              ? 'green'
              : status.state === 'error'
                ? 'red'
                : 'gray'
          }
          aria-live="polite"
        >
          {STATE_LABELS[status.state]}
        </Badge>
      </Group>

      {!status.available && (
        <Alert title="Tailscale is not installed" color="yellow">
          <Text size="sm">
            Use a Hatch Docker image that includes Tailscale. For a source
            installation, build the connection helper with{' '}
            <Code>pnpm tailscale:build</Code>, then refresh this page.
          </Text>
        </Alert>
      )}
      {error && (
        <Alert title="Unable to update connection" color="red">
          {error}
        </Alert>
      )}
      {status.message && (
        <Alert title="Connection needs attention" color="yellow">
          <Text size="sm">{status.message}</Text>
          {/dns|certificate/i.test(status.message) && (
            <Anchor
              href="https://login.tailscale.com/admin/dns"
              target="_blank"
              rel="noreferrer"
              size="sm"
            >
              Open Tailscale DNS settings
            </Anchor>
          )}
        </Alert>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (validName && !status.enabled) void connect(name);
        }}
      >
        <Stack gap="md">
          <TextInput
            label="Device name"
            description="How this Hatch installation appears in Tailscale."
            value={name}
            onChange={(event) => setHostname(event.currentTarget.value)}
            disabled={status.enabled || pending}
            maxLength={63}
            error={
              !validName
                ? 'Use lowercase letters, numbers, and hyphens; start and end with a letter or number.'
                : undefined
            }
          />
          {!status.enabled && (
            <Group>
              <Button
                type="submit"
                loading={pending}
                disabled={!status.available || !validName}
              >
                Connect Tailscale
              </Button>
            </Group>
          )}
        </Stack>
      </form>

      {status.state === 'starting' && (
        <Text component="output" size="sm">
          Connecting to your network. Authorization will open automatically if
          needed.
        </Text>
      )}
      {status.state === 'needs-login' && (
        <Stack gap="sm">
          <Text size="sm">
            Complete authorization with Tailscale to finish connecting. If the
            authorization window is not open, continue below. This page updates
            automatically when you finish.
          </Text>
          <Group>
            {status.loginUrl ? (
              <Anchor
                href={status.loginUrl}
                target="_blank"
                rel="noreferrer"
                size="sm"
              >
                Continue authorization
              </Anchor>
            ) : (
              <Text component="output" size="sm">
                Preparing authorization…
              </Text>
            )}
          </Group>
        </Stack>
      )}
      {status.state === 'needs-approval' && (
        <Alert title="Approve this device" color="blue">
          <Text size="sm">
            Your tailnet requires administrator approval before this device can
            connect.
          </Text>
          <Anchor
            href="https://login.tailscale.com/admin/machines"
            target="_blank"
            rel="noreferrer"
            size="sm"
          >
            Open Tailscale devices
          </Anchor>
        </Alert>
      )}
      {status.state === 'connected' && status.origin && (
        <Stack gap="sm">
          <Text fw={600} size="sm">
            Your private address
          </Text>
          <Anchor
            href={status.origin}
            target="_blank"
            rel="noreferrer"
            style={{ overflowWrap: 'anywhere' }}
          >
            {status.origin}
          </Anchor>
          <Group>
            <Button
              type="button"
              variant="default"
              leftSection={
                copiedOrigin === status.origin ? (
                  <IconCheck size={16} />
                ) : (
                  <IconCopy size={16} />
                )
              }
              onClick={async () => {
                if (await copy(status.origin!)) {
                  setCopiedOrigin(status.origin);
                  toast.success('Address copied');
                } else {
                  toast.error('Could not copy the address');
                }
              }}
            >
              Copy address
            </Button>
            <Button
              component="a"
              href={status.origin}
              target="_blank"
              rel="noreferrer"
              variant="light"
              rightSection={<IconExternalLink size={16} />}
            >
              Open Hatch
            </Button>
          </Group>
        </Stack>
      )}

      {status.enabled && (
        <Group>
          {status.state === 'error' && (
            <Button
              type="button"
              loading={pending}
              disabled={!status.available}
              onClick={() => void connect(status.hostname)}
            >
              Reconnect
            </Button>
          )}
          <Button
            type="button"
            variant="default"
            loading={pending}
            onClick={disconnect}
          >
            {status.state === 'starting' || status.state === 'needs-login'
              ? 'Cancel connection'
              : 'Disconnect'}
          </Button>
        </Group>
      )}
      <Divider />
      <Text size="sm" c="dimmed">
        Hatch remembers this connection and restores it after a restart.
        Disconnecting stops private access and keeps the device identity for
        next time. Your original Hatch address stays available.
      </Text>
    </Stack>
  );
}
