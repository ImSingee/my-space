import {
  ActionIcon,
  Box,
  Button,
  Group,
  Menu,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { ClientOnly } from '@tanstack/react-router';
import { IconDots, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { openTextPromptModal } from '~components/system/text-prompt-modal';
import { sessionQueryOptions, sessionsQueryOptions } from '~queries/agent';
import {
  deleteSession,
  renameSession,
  type SessionSummary,
} from '~server/agent-sessions';
import classes from './chat.module.css';
import { groupSessionsByDate } from './session-groups';
import { useLocalCalendarNow } from './use-local-calendar-now';

function SessionRow({
  session,
  selected,
  onSelect,
  onRename,
  onDelete,
}: {
  session: SessionSummary;
  selected: string | null;
  onSelect: (id: string) => void;
  onRename: (session: SessionSummary) => void;
  onDelete: (id: string, title: string) => void;
}) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      gap="xs"
      className={
        session.id === selected
          ? classes.sessionItemActive
          : classes.sessionItem
      }
    >
      <UnstyledButton
        className={classes.sessionItemLabel}
        onClick={() => onSelect(session.id)}
      >
        <Text size="sm" truncate>
          {session.title}
        </Text>
      </UnstyledButton>
      <Menu position="bottom-end" withArrow shadow="md" width={160}>
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            className={classes.sessionAction}
            aria-label="Chat options"
          >
            <IconDots size={15} stroke={1.7} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconPencil size={15} stroke={1.7} />}
            onClick={() => onRename(session)}
          >
            Rename
          </Menu.Item>
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={15} stroke={1.7} />}
            onClick={() => onDelete(session.id, session.title)}
          >
            Delete
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

export function SessionsPanel({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  const { data: sessions } = useSuspenseQuery(sessionsQueryOptions);
  const calendarNow = useLocalCalendarNow();
  const groups = groupSessionsByDate(sessions, calendarNow);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: sessionsQueryOptions.queryKey });

  const remove = useMutation({
    mutationFn: (id: string) => deleteSession({ data: { id } }),
    onSuccess: async (_res, id) => {
      await invalidate();
      // Drop the cached transcript so a browser Back to the deleted thread
      // refetches (and renders empty) instead of replaying the stale messages.
      qc.removeQueries({ queryKey: sessionQueryOptions(id).queryKey });
      if (selected === id) onSelect(null);
      toast.success('Chat deleted');
    },
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; title: string }) =>
      renameSession({ data: input }),
    onSuccess: async (_res, variables) => {
      await invalidate();
      // The list refresh alone leaves the open chat's detail query stale, so
      // its header keeps the old title until a hard reload — refetch it too.
      await qc.invalidateQueries({
        queryKey: sessionQueryOptions(variables.id).queryKey,
      });
      toast.success('Chat renamed');
    },
  });

  const openRename = (s: { id: string; title: string }) =>
    openTextPromptModal({
      title: 'Rename chat',
      label: 'Title',
      initialValue: s.title,
      onSubmit: (title) => rename.mutateAsync({ id: s.id, title }),
    });

  const confirmDelete = (id: string, title: string) =>
    modals.openConfirmModal({
      title: 'Delete chat',
      centered: true,
      children: <Text size="sm">Delete “{title}”?</Text>,
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(id),
    });

  const renderSession = (session: SessionSummary) => (
    <SessionRow
      key={session.id}
      session={session}
      selected={selected}
      onSelect={onSelect}
      onRename={openRename}
      onDelete={confirmDelete}
    />
  );

  return (
    <Box className={classes.sessions}>
      <Box className={classes.sessionsHead}>
        <Button
          fullWidth
          variant={selected === null ? 'light' : 'default'}
          leftSection={<IconPlus size={16} stroke={2} />}
          onClick={() => onSelect(null)}
        >
          New chat
        </Button>
      </Box>
      <ScrollArea
        className={classes.sessionsList}
        type="scroll"
        scrollbarSize={6}
      >
        <Stack gap="sm">
          {sessions.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="md">
              No chats yet.
            </Text>
          ) : (
            <ClientOnly
              fallback={<Stack gap={2}>{sessions.map(renderSession)}</Stack>}
            >
              {groups.map((group) => (
                <Box component="section" key={group.key}>
                  <Text component="h2" className={classes.sessionGroupTitle}>
                    {group.label}
                  </Text>
                  <Stack gap={2}>{group.sessions.map(renderSession)}</Stack>
                </Box>
              ))}
            </ClientOnly>
          )}
        </Stack>
      </ScrollArea>
    </Box>
  );
}
