import {
  ActionIcon,
  Box,
  Button,
  Group,
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
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { sessionsQueryOptions } from '~queries/agent';
import { createSession, deleteSession } from '~server/agent-sessions';
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

  useEffect(() => {
    if (!selected && sessions.length > 0) {
      onSelect(sessions[0].id);
    }
  }, [sessions, selected, onSelect]);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: sessionsQueryOptions.queryKey });

  const create = useMutation({
    mutationFn: () => createSession({ data: {} }),
    onSuccess: async ({ id }) => {
      await invalidate();
      onSelect(id);
    },
    onError: () => toast.error('Could not create chat'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteSession({ data: { id } }),
    onSuccess: async (_res, id) => {
      await invalidate();
      if (selected === id) onSelect(null);
      toast.success('Chat deleted');
    },
  });

  return (
    <Box className={classes.sessions}>
      <Box className={classes.sessionsHead}>
        <Button
          fullWidth
          variant="light"
          leftSection={<IconPlus size={16} stroke={2} />}
          onClick={() => create.mutate()}
          loading={create.isPending}
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
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  className={classes.sessionDelete}
                  aria-label="Delete chat"
                  onClick={() =>
                    modals.openConfirmModal({
                      title: 'Delete chat',
                      centered: true,
                      children: <Text size="sm">Delete “{s.title}”?</Text>,
                      labels: { confirm: 'Delete', cancel: 'Cancel' },
                      confirmProps: { color: 'red' },
                      onConfirm: () => remove.mutate(s.id),
                    })
                  }
                >
                  <IconTrash size={14} stroke={1.6} />
                </ActionIcon>
              </Group>
            ))
          )}
        </Stack>
      </ScrollArea>
    </Box>
  );
}
