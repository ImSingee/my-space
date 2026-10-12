import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Divider,
  Group,
  Loader,
  PasswordInput,
  Radio,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconCircleX,
  IconCopy,
  IconExternalLink,
  IconHelpCircle,
  IconInfoCircle,
} from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { tailscaleQueryOptions } from '~queries/tailscale';
import { configureTailscale } from '~server/tailscale';
import {
  tailscaleConfigSchema,
  tailscaleAuthKeySchema,
  tailscaleLoginUrlSchema,
  type TailscaleConfigureInput,
  type TailscaleStatus,
} from '~/tailscale';
import { openTailscaleAuthorization } from './tailscale-authorization';
import classes from './tailscale-panel.module.css';

const STATES = {
  disconnected: { label: 'Not connected', color: 'gray' },
  starting: { label: 'Connecting', color: 'blue' },
  'preparing-https': { label: 'Preparing HTTPS', color: 'blue' },
  'needs-login': { label: 'Waiting for sign-in', color: 'blue' },
  'needs-approval': { label: 'Waiting for approval', color: 'blue' },
  connected: { label: 'Connected', color: 'green' },
  error: { label: 'Needs attention', color: 'red' },
} as const satisfies Record<
  TailscaleStatus['state'],
  { label: string; color: string }
>;

const LOGIN_METHODS = [
  {
    value: 'interactive',
    label: 'Interactive sign-in',
    description: 'Sign in with your Tailscale account in a new window.',
  },
  {
    value: 'auth-key',
    label: 'Auth key',
    description:
      'Paste a key from the Tailscale admin console. No sign-in window opens.',
  },
] as const;

type LoginMethod = (typeof LOGIN_METHODS)[number]['value'];

const DNS_SETTINGS_URL = 'https://login.tailscale.com/admin/dns';
const DEVICES_URL = 'https://login.tailscale.com/admin/machines';
const AUTH_KEYS_URL = 'https://login.tailscale.com/admin/settings/keys';

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

function ExternalButton({ href, label }: { href: string; label: string }) {
  return (
    <Button
      component="a"
      href={href}
      target="_blank"
      rel="noreferrer"
      variant="default"
      rightSection={<IconExternalLink size={16} />}
    >
      {label}
    </Button>
  );
}

export function TailscaleSettings() {
  const queryClient = useQueryClient();
  const query = useQuery(tailscaleQueryOptions);
  const request = useRef<TailscaleConfigureInput | null>(null);
  const mutation = useMutation({
    meta: { errorToast: false },
    networkMode: 'always',
    retry: false,
    gcTime: 0,
    onMutate: () =>
      queryClient.cancelQueries({ queryKey: tailscaleQueryOptions.queryKey }),
    // Mutation variables are cached. Read a single-use request instead.
    mutationFn: async () => {
      const data = request.current;
      request.current = null;
      if (!data) throw new Error('Connection request is unavailable.');
      return configureTailscale({ data });
    },
    onSuccess: (status) => {
      queryClient.setQueryData(tailscaleQueryOptions.queryKey, status);
    },
  });
  if (!query.data) {
    if (!query.error) {
      return (
        <Stack gap="lg">
          <Skeleton height={28} width={160} />
          <Skeleton height={60} />
          <Skeleton height={84} />
          <Skeleton height={36} width={170} />
        </Stack>
      );
    }
    return (
      <Alert
        color="red"
        title="Connection status unavailable"
        icon={<IconAlertCircle size={18} />}
      >
        <Stack gap="sm" align="flex-start">
          <Text size="sm">
            {query.error?.message ?? 'Loading connection status…'}
          </Text>
          <Button
            type="button"
            variant="default"
            onClick={() => void query.refetch()}
            loading={query.isFetching}
          >
            Try again
          </Button>
        </Stack>
      </Alert>
    );
  }
  return (
    <TailscalePanel
      status={query.data}
      pending={mutation.isPending}
      error={mutation.error?.message ?? query.error?.message ?? null}
      onConfigure={async (input) => {
        request.current = input;
        try {
          return await mutation.mutateAsync();
        } finally {
          request.current = null;
        }
      }}
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
  onConfigure: (config: TailscaleConfigureInput) => Promise<TailscaleStatus>;
}) {
  const [hostname, setHostname] = useState<string | null>(null);
  const [copiedOrigin, setCopiedOrigin] = useState<string | null>(null);
  const [loginMethod, setLoginMethod] = useState<LoginMethod>('interactive');
  const [authKey, setAuthKey] = useState('');
  const submitting = useRef(false);
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
  const canAuthenticate =
    !status.enabled ||
    status.state === 'needs-login' ||
    (status.state === 'error' && !status.dns && !status.https);
  const usesAuthKey = canAuthenticate && loginMethod === 'auth-key';
  const connect = async (deviceName: string) => {
    if (pending || submitting.current || !status.available) return;
    const key = usesAuthKey ? tailscaleAuthKeySchema.safeParse(authKey) : null;
    if (key && !key.success) return;
    submitting.current = true;
    finishAuthorization();
    const attempt = {
      popup: !key ? openTailscaleAuthorization() : null,
      ready: false,
      navigated: false,
    };
    authorization.current = attempt;
    setAuthKey('');
    try {
      const next = await onConfigure({
        enabled: true,
        hostname: deviceName,
        ...(key?.success ? { authKey: key.data } : {}),
      });
      if (authorization.current !== attempt) return;
      attempt.ready = true;
      syncAuthorization(next);
    } catch {
      if (authorization.current === attempt) finishAuthorization();
    } finally {
      submitting.current = false;
    }
  };
  const name = status.enabled ? status.hostname : (hostname ?? status.hostname);
  const validName =
    tailscaleConfigSchema.shape.hostname.safeParse(name).success;
  const validKey = tailscaleAuthKeySchema.safeParse(authKey).success;
  const keyReady = !usesAuthKey || validKey;
  const chooseLoginMethod = (value: string) => {
    // Re-selecting the current method must not close a pending sign-in.
    if (value === loginMethod) return;
    finishAuthorization();
    setAuthKey('');
    setLoginMethod(value === 'auth-key' ? 'auth-key' : 'interactive');
  };
  const disconnect = () => {
    const apply = () => {
      finishAuthorization();
      setAuthKey('');
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
  // Errors that still allow signing in mean the connection itself failed;
  // DNS and certificate problems are settings the user can fix and wait on.
  const connectionFailed = status.state === 'error' && canAuthenticate;
  const problemTitle =
    httpsProblem?.title ??
    (httpsNotReady
      ? 'HTTPS is not ready'
      : connectionFailed
        ? 'Could not connect to Tailscale'
        : 'Connection needs attention');
  const problemColor =
    httpsProblem?.color ?? (connectionFailed ? 'red' : 'yellow');
  const retryAt =
    status.https?.phase === 'rate-limited' ? status.https.retryAt : null;
  const retryTime = retryAt ? dayjs(retryAt) : null;
  // Typed helper statuses decide from their phase; older helpers only
  // identify DNS or certificate settings problems through their message.
  const showDnsSettings = httpsProblem
    ? httpsProblem.dnsSettings
    : Boolean(status.dns) ||
      /dns|certificate settings/i.test(status.message ?? '');
  const badge = httpsProblem
    ? { label: httpsProblem.badge, color: httpsProblem.color }
    : {
        label: STATES[status.state].label,
        color:
          status.state === 'error' ? problemColor : STATES[status.state].color,
      };
  const working =
    status.state === 'starting' || status.state === 'preparing-https';
  // Restarting cannot lift a provider rate limit; the helper already waits
  // until the retry time. A pending interactive sign-in continues through its
  // authorization link instead.
  const submitLabel = !status.enabled
    ? 'Connect Tailscale'
    : (status.state === 'error' && status.https?.phase !== 'rate-limited') ||
        (status.state === 'needs-login' && usesAuthKey)
      ? 'Reconnect'
      : null;

  return (
    <Stack gap="lg">
      <div className={classes.status}>
        <div className={classes.statusMain}>
          <Badge
            size="lg"
            radius="sm"
            variant="light"
            color={badge.color}
            leftSection={
              working && !httpsProblem ? (
                <Loader size={10} color={badge.color} />
              ) : undefined
            }
            className={classes.badge}
            aria-live="polite"
          >
            {badge.label}
          </Badge>
          {status.enabled && (
            <Text size="sm" c="dimmed" truncate className={classes.device}>
              Device{' '}
              <Text span inherit fw={500} c="var(--mantine-color-text)">
                {status.hostname}
              </Text>
            </Text>
          )}
        </div>
        {status.enabled && (
          <Button
            type="button"
            variant="default"
            loading={pending}
            onClick={disconnect}
          >
            {working || status.state === 'needs-login'
              ? 'Cancel connection'
              : 'Disconnect'}
          </Button>
        )}
      </div>

      {!status.available && (
        <Alert
          title="Tailscale is not installed"
          color="yellow"
          icon={<IconAlertTriangle size={18} />}
        >
          <Text size="sm">
            Use a Hatch Docker image that includes Tailscale. For a source
            installation, build the connection helper with{' '}
            <Code>pnpm tailscale:build</Code>, then refresh this page.
          </Text>
        </Alert>
      )}
      {error && (
        <Alert
          title="Could not update the connection"
          color="red"
          icon={<IconAlertCircle size={18} />}
        >
          {error}
        </Alert>
      )}
      {status.state === 'starting' && (
        <Text component="output" size="sm" c="dimmed">
          Connecting to your tailnet. With interactive sign-in, the
          authorization window continues automatically if Tailscale asks you to
          sign in.
        </Text>
      )}
      {status.state === 'needs-login' && loginMethod === 'interactive' && (
        <Alert
          title="Finish signing in to Tailscale"
          color="blue"
          role="note"
          icon={<IconInfoCircle size={18} />}
        >
          <Stack gap="sm" align="flex-start">
            <Text size="sm">
              Complete authorization in the Tailscale window. If it didn’t open
              or you closed it, continue here. This page updates when you
              finish.
            </Text>
            {status.loginUrl ? (
              <ExternalButton
                href={status.loginUrl}
                label="Continue authorization"
              />
            ) : (
              <Text component="output" size="sm">
                Preparing authorization…
              </Text>
            )}
          </Stack>
        </Alert>
      )}
      {status.state === 'needs-approval' && (
        <Alert
          title="Approve this device"
          color="blue"
          role="note"
          icon={<IconInfoCircle size={18} />}
        >
          <Stack gap="sm" align="flex-start">
            <Text size="sm">
              Your tailnet requires an admin to approve new devices. Approve{' '}
              <Text span inherit fw={600}>
                {status.hostname}
              </Text>{' '}
              in the Tailscale admin console; this page updates automatically.
            </Text>
            <ExternalButton href={DEVICES_URL} label="Open Tailscale devices" />
          </Stack>
        </Alert>
      )}
      {status.state === 'preparing-https' && (
        <Alert
          title="Preparing your secure address"
          color="blue"
          role="note"
          aria-live="polite"
          icon={<IconInfoCircle size={18} />}
        >
          <Text size="sm">
            Your device is connected to Tailscale. Hatch is getting its HTTPS
            certificate, which can take a few minutes the first time. You can
            leave this page; your private address appears here when it’s ready.
          </Text>
        </Alert>
      )}
      {status.message && status.state !== 'preparing-https' && (
        <Alert
          title={problemTitle}
          color={problemColor}
          icon={
            problemColor === 'red' ? (
              <IconAlertCircle size={18} />
            ) : (
              <IconAlertTriangle size={18} />
            )
          }
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
              <ExternalButton
                href={DNS_SETTINGS_URL}
                label="Open Tailscale DNS settings"
              />
            )}
          </Stack>
        </Alert>
      )}
      {status.state === 'connected' && status.origin && (
        <Stack gap="xs">
          <Text size="sm" fw={600}>
            Private address
          </Text>
          <Anchor
            href={status.origin}
            target="_blank"
            rel="noreferrer"
            fw={500}
            td="underline"
            className={classes.address}
          >
            {status.origin}
          </Anchor>
          <Text size="sm" c="dimmed">
            Open it from any device signed in to your tailnet.
          </Text>
          <Group gap="sm" mt={4}>
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

      {(canAuthenticate || submitLabel) && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (submitLabel && validName && keyReady) void connect(name);
          }}
        >
          <Stack gap="lg">
            {!status.enabled && (
              <TextInput
                label="Device name"
                description="Names this device in Tailscale and in its private address."
                value={name}
                onChange={(event) => setHostname(event.currentTarget.value)}
                disabled={pending}
                maxLength={63}
                error={
                  !validName
                    ? 'Use lowercase letters, numbers, and hyphens; start and end with a letter or number.'
                    : undefined
                }
              />
            )}
            {canAuthenticate && (
              <Radio.Group
                label="Sign-in method"
                value={loginMethod}
                onChange={chooseLoginMethod}
              >
                <div className={classes.methods}>
                  {LOGIN_METHODS.map((method) => (
                    <Radio.Card
                      key={method.value}
                      value={method.value}
                      disabled={pending}
                      className={classes.method}
                    >
                      <Radio.Indicator className={classes.methodIndicator} />
                      <div>
                        <Text size="sm" fw={500}>
                          {method.label}
                        </Text>
                        <Text size="sm" c="dimmed">
                          {method.description}
                        </Text>
                      </div>
                    </Radio.Card>
                  ))}
                </div>
              </Radio.Group>
            )}
            {usesAuthKey && (
              <PasswordInput
                label="Auth key"
                description={
                  <>
                    Used once to add this device. Hatch doesn’t save it.{' '}
                    <Anchor
                      href={AUTH_KEYS_URL}
                      target="_blank"
                      rel="noreferrer"
                      inherit
                      td="underline"
                    >
                      Create an auth key
                    </Anchor>
                  </>
                }
                placeholder="tskey-auth-…"
                value={authKey}
                disabled={pending}
                maxLength={4096}
                // A single-use enrollment key is not a site password: keep
                // spelling services and password managers away from it.
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                onChange={(event) => setAuthKey(event.currentTarget.value)}
                error={
                  authKey && !validKey
                    ? 'Enter the key exactly as Tailscale shows it, without spaces.'
                    : undefined
                }
              />
            )}
            {submitLabel && (
              <Group>
                <Button
                  type="submit"
                  loading={pending}
                  disabled={!status.available || !validName || !keyReady}
                >
                  {submitLabel}
                </Button>
              </Group>
            )}
          </Stack>
        </form>
      )}

      <Divider />
      <Text size="sm" c="dimmed">
        Hatch restores this connection after a restart. Disconnecting turns off
        private access and keeps the device identity for next time. Your
        original Hatch address keeps working.
      </Text>
    </Stack>
  );
}
