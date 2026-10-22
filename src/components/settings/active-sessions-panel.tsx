import {
  Alert,
  Badge,
  Button,
  Group,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconAlertCircle } from '@tabler/icons-react';
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  accountSessionsQueryOptions,
  signOutSession,
  type AccountSession,
} from '~queries/account-sessions';
import classes from './active-sessions-panel.module.css';
import {
  DEVICE_ICONS,
  describeUserAgent,
  formatSessionTime,
} from './session-device';

const REVOKE_KEY = ['auth', 'account-sessions', 'revoke'];

export function ActiveSessionsPanel() {
  const queryClient = useQueryClient();
  const sessions = useQuery(accountSessionsQueryOptions);

  // Failures are toasted by the global mutation handler and leave the list
  // untouched, so the same control retries.
  const revoke = useMutation({
    mutationKey: REVOKE_KEY,
    networkMode: 'always',
    retry: false,
    mutationFn: (sessionId: string) => signOutSession(sessionId),
    onSuccess: (_result, sessionId) => {
      queryClient.setQueryData(
        accountSessionsQueryOptions.queryKey,
        (current) => current?.filter((session) => session.id !== sessionId),
      );
      toast.success('Device signed out');
      // Stay pending until the list is refetched, so the controls cannot act
      // on a stale list.
      return queryClient.invalidateQueries({
        queryKey: accountSessionsQueryOptions.queryKey,
      });
    },
  });
  const revokingIds = useMutationState({
    filters: { mutationKey: REVOKE_KEY, status: 'pending' },
    select: (mutation) => mutation.state.variables as string,
  });

  // Read the mutation cache synchronously: a confirm dialog opened before a
  // request started must not send a duplicate.
  const isRevoking = (sessionId: string) =>
    queryClient.isMutating({
      mutationKey: REVOKE_KEY,
      predicate: (mutation) => mutation.state.variables === sessionId,
    }) > 0;

  const confirmRevoke = (session: AccountSession) => {
    const { label } = describeUserAgent(session.userAgent);
    modals.openConfirmModal({
      title: `Sign out ${label}?`,
      centered: true,
      children: (
        <Text size="sm">
          The session last active {formatSessionTime(session.updatedAt)} ends
          immediately and must sign in again. Other sessions on the same device
          are not affected.
        </Text>
      ),
      labels: { confirm: 'Sign out session', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        if (!isRevoking(session.id)) revoke.mutate(session.id);
      },
    });
  };

  const ordered = sessions.data
    ? // The current session leads; the rest keep newest-first order.
      [
        ...sessions.data.filter((session) => session.isCurrent),
        ...sessions.data.filter((session) => !session.isCurrent),
      ]
    : [];

  return (
    <Stack gap="md">
      <Stack gap={2}>
        <Text fw={600}>Active sessions</Text>
        <Text size="sm" c="dimmed">
          Every session signed in to your account right now. Each browser or CLI
          sign-in is listed separately, so one device can appear more than once.
          Sign out any you don’t recognize.
        </Text>
      </Stack>

      {sessions.isPending ? (
        <ActiveSessionsSkeleton />
      ) : sessions.isLoadingError ? (
        <Alert
          icon={<IconAlertCircle size={18} />}
          title="Active sessions could not be loaded"
          color="red"
        >
          <Stack gap="xs" align="flex-start">
            <Text size="sm">Check your connection and try again.</Text>
            <Button
              type="button"
              size="xs"
              variant="light"
              color="red"
              loading={sessions.isFetching}
              onClick={() => void sessions.refetch()}
            >
              Try again
            </Button>
          </Stack>
        </Alert>
      ) : ordered.length > 0 ? (
        <ul className={classes.list} aria-label="Active sessions">
          {ordered.map((session) => (
            <ActiveSessionRow
              key={session.id}
              session={session}
              revoking={revokingIds.includes(session.id)}
              onRevoke={() => confirmRevoke(session)}
            />
          ))}
        </ul>
      ) : (
        <Text size="sm" c="dimmed" className={classes.empty}>
          No active sessions.
        </Text>
      )}
    </Stack>
  );
}

function ActiveSessionRow({
  session,
  revoking,
  onRevoke,
}: {
  session: AccountSession;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const device = describeUserAgent(session.userAgent);
  const DeviceIcon = DEVICE_ICONS[device.kind];
  const lastActive = formatSessionTime(session.updatedAt);

  return (
    <li className={classes.row}>
      <Group
        gap="sm"
        wrap="nowrap"
        align="flex-start"
        className={classes.identity}
      >
        <ThemeIcon
          variant="light"
          color={session.isCurrent ? undefined : 'gray'}
          size="lg"
          radius="md"
        >
          <DeviceIcon size={18} stroke={1.7} />
        </ThemeIcon>
        <Stack gap={4} miw={0} flex={1}>
          <Group gap={8} wrap="nowrap" miw={0}>
            <Text
              size="sm"
              fw={600}
              truncate
              title={session.userAgent ?? undefined}
            >
              {device.label}
            </Text>
            {session.isCurrent && (
              <Badge size="sm" variant="light" className={classes.badge}>
                Current session
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            Last active <time dateTime={session.updatedAt}>{lastActive}</time>
          </Text>
        </Stack>
      </Group>

      {!session.isCurrent && (
        <Button
          type="button"
          size="xs"
          variant="subtle"
          color="red"
          aria-label={`Sign out ${device.label}, last active ${lastActive}`}
          loading={revoking}
          onClick={onRevoke}
          className={classes.action}
        >
          Sign out
        </Button>
      )}
    </li>
  );
}

function ActiveSessionsSkeleton() {
  return (
    <Stack gap="xs" aria-label="Loading active sessions" aria-busy>
      {[0, 1].map((key) => (
        <Group key={key} gap="sm" wrap="nowrap" py="xs">
          <Skeleton height={34} width={34} radius="md" />
          <Stack gap={5} flex={1}>
            <Skeleton height={14} width="35%" radius="sm" />
            <Skeleton height={10} width="45%" radius="sm" />
          </Stack>
        </Group>
      ))}
    </Stack>
  );
}
