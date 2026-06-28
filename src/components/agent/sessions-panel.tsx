import {
  ActionIcon,
  Box,
  Button,
  Group,
  Menu,
  Modal,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { IconDots, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { sessionQueryOptions, sessionsQueryOptions } from '~queries/agent';
import { deleteSession, renameSession } from '~server/agent-sessions';
import classes from './chat.module.css';

export function SessionsPanel({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  const { data: sessions } = useSuspenseQuery(sessionsQueryOptions);
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState('');

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
      setRenameTarget(null);
      toast.success('Chat renamed');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const submitRename = () => {
    if (renameTarget && renameValue.trim()) {
      rename.mutate({ id: renameTarget.id, title: renameValue.trim() });
    }
  };

  const confirmDelete = (id: string, title: string) =>
    modals.openConfirmModal({
      title: 'Delete chat',
      centered: true,
      children: <Text size="sm">Delete “{title}”?</Text>,
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(id),
    });

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
        <Stack gap={2}>
          {sessions.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="md">
              No chats yet.
            </Text>
          ) : (
            sessions.map((s) => (
              <Group
                key={s.id}
                justify="space-between"
                wrap="nowrap"
                gap="xs"
                className={
                  s.id === selected
                    ? classes.sessionItemActive
                    : classes.sessionItem
                }
              >
                <UnstyledButton
                  className={classes.sessionItemLabel}
                  onClick={() => onSelect(s.id)}
                >
                  <Text size="sm" truncate>
                    {s.title}
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
                      onClick={() => {
                        setRenameTarget({ id: s.id, title: s.title });
                        setRenameValue(s.title);
                      }}
                    >
                      Rename
                    </Menu.Item>
                    <Menu.Item
                      color="red"
                      leftSection={<IconTrash size={15} stroke={1.7} />}
                      onClick={() => confirmDelete(s.id, s.title)}
                    >
                      Delete
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Group>
            ))
          )}
        </Stack>
      </ScrollArea>

      <Modal
        opened={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title="Rename chat"
        centered
      >
        <Stack gap="sm">
          <TextInput
            data-autofocus
            label="Title"
            value={renameValue}
            onChange={(e) => setRenameValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitRename();
              }
            }}
          />
          <Group justify="flex-end">
            <Button
              type="button"
              loading={rename.isPending}
              disabled={!renameValue.trim()}
              onClick={submitRename}
            >
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Box>
  );
}
