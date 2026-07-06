import {
  ActionIcon,
  Avatar,
  Badge,
  Divider,
  Group,
  Stack,
  Switch,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { IconTrash } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { toast } from 'sonner';
import { usersPanelQueryOptions } from '~queries/users';
import {
  deleteUser,
  updateAllowSignup,
  type PlatformUser,
} from '~server/users';

export function UsersPanel() {
  const qc = useQueryClient();
  const { data } = useSuspenseQuery(usersPanelQueryOptions);

  const toggleSignup = useMutation({
    mutationFn: (allowSignup: boolean) =>
      updateAllowSignup({ data: { allowSignup } }),
    onSuccess: async ({ allowSignup }) => {
      await qc.invalidateQueries({
        queryKey: usersPanelQueryOptions.queryKey,
      });
      toast.success(allowSignup ? 'Sign-up enabled' : 'Sign-up disabled');
    },
  });

  const removeUser = useMutation({
    mutationFn: (userId: string) => deleteUser({ data: { userId } }),
    // Invalidate on failure too (error toast comes from the global mutation
    // handler): "User not found" / "last user" mean the list changed under
    // us, so refetch it.
    onSettled: () =>
      qc.invalidateQueries({ queryKey: usersPanelQueryOptions.queryKey }),
    onSuccess: () => toast.success('User deleted'),
  });

  const confirmDelete = (user: PlatformUser) =>
    modals.openConfirmModal({
      title: `Delete ${user.name || user.email}?`,
      centered: true,
      children: (
        <Text size="sm">
          This permanently removes the account and signs it out everywhere.
          Apps, dashboards, and other platform data are shared and stay intact.
        </Text>
      ),
      labels: { confirm: 'Delete user', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => removeUser.mutate(user.id),
    });

  return (
    <Stack gap="md">
      <Group justify="space-between" gap="md" py="xs" wrap="nowrap">
        <Stack gap={2}>
          <Text fw={600}>Allow sign-up</Text>
          <Text size="sm" c="dimmed">
            Let anyone who can reach this space create an account. Every account
            gets full access, so keep this off unless you are inviting someone.
          </Text>
        </Stack>
        <Switch
          size="md"
          // While the mutation is in flight, show the state being requested
          // instead of the (still-unchanged) query data. On failure the
          // global mutation toast reports it and the switch snaps back to
          // the cached server value.
          checked={
            toggleSignup.isPending
              ? (toggleSignup.variables ?? data.allowSignup)
              : data.allowSignup
          }
          disabled={toggleSignup.isPending}
          onChange={(event) => toggleSignup.mutate(event.currentTarget.checked)}
          aria-label="Allow sign-up"
        />
      </Group>

      <Divider />

      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>User</Table.Th>
            <Table.Th>Joined</Table.Th>
            <Table.Th w={48} aria-label="Actions" />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              isCurrent={user.id === data.currentUserId}
              deleting={
                removeUser.isPending && removeUser.variables === user.id
              }
              onDelete={() => confirmDelete(user)}
            />
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function UserRow({
  user,
  isCurrent,
  deleting,
  onDelete,
}: {
  user: PlatformUser;
  isCurrent: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap="sm" wrap="nowrap">
          <Avatar
            size={36}
            radius="xl"
            name={user.name || user.email}
            src={user.image}
          />
          <Stack gap={0} miw={0}>
            <Group gap={6} wrap="nowrap">
              <Text size="sm" fw={600} truncate>
                {user.name || user.email}
              </Text>
              {isCurrent && (
                <Badge size="xs" variant="light">
                  You
                </Badge>
              )}
              {user.emailVerified && (
                <Badge size="xs" variant="light" color="teal">
                  Verified
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed" truncate>
              {user.email}
            </Text>
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {dayjs(user.createdAt).format('MMM D, YYYY')}
        </Text>
      </Table.Td>
      <Table.Td>
        {isCurrent ? (
          <ActionIcon
            variant="subtle"
            color="gray"
            disabled
            aria-label="You cannot delete the account you are signed in with"
          >
            <IconTrash size={16} stroke={1.6} />
          </ActionIcon>
        ) : (
          <Tooltip label="Delete user" withArrow>
            <ActionIcon
              variant="subtle"
              color="red"
              loading={deleting}
              onClick={onDelete}
              aria-label={`Delete ${user.email}`}
            >
              <IconTrash size={16} stroke={1.6} />
            </ActionIcon>
          </Tooltip>
        )}
      </Table.Td>
    </Table.Tr>
  );
}
