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
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconCheck,
  IconCircleCheck,
  IconCircleX,
  IconCopy,
  IconExternalLink,
  IconHelpCircle,
} from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import dayjs from 'dayjs';
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
  'preparing-https': 'Preparing HTTPS',
  'needs-login': 'Authorizing',
  'needs-approval': 'Waiting for device approval',
  connected: 'Connected',
  error: 'Needs attention',
} as const;

const DNS_SETTINGS_URL = 'https://login.tailscale.com/admin/dns';

type HttpsPhase = NonNullable<TailscaleStatus['https']>['phase'];

// DNS settings only help when the certificate itself has stalled; a provider
// rate limit or a listener failure is not fixed there.
const HTTPS_PROBLEMS: Partial<
  Record<
    HttpsPhase,
    { title: string; badge: string; color: string; dnsSettings: boolean }
  >
> = {
  'certificate-delayed': {
    title: 'HTTPS is taking longer than expected',
    badge: 'HTTPS delayed',
    color: 'yellow',
    dnsSettings: true,
  },
  'rate-limited': {
    title: 'Certificate requests are temporarily limited',
    badge: 'Waiting to retry',
    color: 'yellow',
    dnsSettings: false,
  },
  'listener-error': {
    title: 'Secure address could not start',
    badge: 'Needs attention',
    color: 'red',
    dnsSettings: false,
  },
};

function DnsSettingRow({
  name,
  enabled,
}: {
  name: string;
  enabled?: boolean | null;
}) {
  // A missing value means the helper could not read the setting, not that it
  // is off, so only an explicit false is reported as not enabled.
  const { label, Icon, color } =
    enabled === true
      ? {
          label: 'Enabled',
          Icon: IconCircleCheck,
          color: 'var(--mantine-color-green-7)',
        }
      : enabled === false
        ? {
            label: 'Not enabled',
            Icon: IconCircleX,
            color: 'var(--mantine-color-red-7)',
          }
        : {
            label: 'Unknown',
            Icon: IconHelpCircle,
            color: 'var(--mantine-color-dimmed)',
          };
  return (
    <Table.Tr>
      <Table.Th scope="row" fw={400} pr="xl">
        {name}
      </Table.Th>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          <Icon size={16} color={color} aria-hidden />
          <Text span size="sm" fw={500}>
            {label}
          </Text>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

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
  const httpsProblem =
    status.state === 'error' && status.https
      ? HTTPS_PROBLEMS[status.https.phase]
      : undefined;
  // Helpers without HTTPS phases only report an error with both DNS settings
  // on when the certificate or HTTPS listener is not ready.
  const httpsNotReady =
    !status.https &&
    status.dns?.magicDnsEnabled === true &&
    status.dns.httpsCertificatesEnabled === true;
  const retryAt =
    status.https?.phase === 'rate-limited' ? status.https.retryAt : null;
  const retryTime = retryAt ? dayjs(retryAt) : null;
  // Typed helper statuses decide from their phase; older helpers only
  // identify DNS or certificate settings problems through their message.
  const showDnsSettings = httpsProblem
    ? httpsProblem.dnsSettings
    : Boolean(status.dns) ||
      /dns|certificate settings/i.test(status.message ?? '');
  const badge = httpsProblem ?? {
    badge: STATE_LABELS[status.state],
    color:
      status.state === 'connected'
        ? 'green'
        : status.state === 'error'
          ? 'red'
          : 'gray',
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
        <Badge variant="light" color={badge.color} aria-live="polite">
          {badge.badge}
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
      {status.state === 'preparing-https' && (
        <Alert
          title="Preparing your secure address"
          color="blue"
          role="note"
          aria-live="polite"
        >
          <Text size="sm">
            Your device is connected to Tailscale. We’re preparing its HTTPS
            certificate so you can open Hatch securely. First-time setup can
            take a few minutes. You can leave this page; Hatch will keep trying
            and show your private address when it’s ready.
          </Text>
        </Alert>
      )}
      {status.message && status.state !== 'preparing-https' && (
        <Alert
          title={
            httpsProblem?.title ??
            (httpsNotReady
              ? 'HTTPS is not ready'
              : 'Connection needs attention')
          }
          color={httpsProblem?.color ?? 'yellow'}
        >
          <Stack gap="sm" align="flex-start">
            <Text size="sm">{status.message}</Text>
            {retryAt && retryTime?.isValid() && (
              <Text size="sm">
                Next automatic attempt:{' '}
                <Text span fw={500} component="time" dateTime={retryAt}>
                  {retryTime.format(
                    retryTime.isSame(dayjs(), 'day')
                      ? 'h:mm A'
                      : 'MMM D [at] h:mm A',
                  )}
                </Text>
              </Text>
            )}
            {status.dns && (
              <Table
                aria-label="Tailscale DNS settings"
                w="auto"
                fz="sm"
                horizontalSpacing={0}
                verticalSpacing={4}
                withRowBorders={false}
              >
                <Table.Tbody>
                  <DnsSettingRow
                    name="MagicDNS"
                    enabled={status.dns.magicDnsEnabled}
                  />
                  <DnsSettingRow
                    name="HTTPS certificates"
                    enabled={status.dns.httpsCertificatesEnabled}
                  />
                </Table.Tbody>
              </Table>
            )}
            {showDnsSettings && (
              <Button
                component="a"
                href={DNS_SETTINGS_URL}
                target="_blank"
                rel="noreferrer"
                variant="default"
                rightSection={<IconExternalLink size={16} />}
              >
                Open Tailscale DNS settings
              </Button>
            )}
          </Stack>
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
          {/* Restarting cannot lift a provider rate limit; the helper already
              waits until the retry time. */}
          {status.state === 'error' &&
            status.https?.phase !== 'rate-limited' && (
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
            {status.state === 'starting' ||
            status.state === 'needs-login' ||
            status.state === 'preparing-https'
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
