import { Menu, NavLink, Stack, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { IconRepeat, IconSparkles } from '@tabler/icons-react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { workflowsQueryOptions } from '~queries/workflows';
import { setWorkflowPinFn } from '~server/workflows';
import {
  AddActionButton,
  AddMenuButton,
  PinnedRow,
  SectionHeading,
  useIsActive,
} from './section';

export function PinnedWorkflows() {
  const isActive = useIsActive();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: workflows } = useQuery(workflowsQueryOptions);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: workflowsQueryOptions.queryKey,
    });

  const setPin = useMutation({
    mutationFn: (input: { id: string; pinned: boolean }) =>
      setWorkflowPinFn({ data: input }),
    onSuccess: (_res, input) => {
      void invalidate();
      toast.success(input.pinned ? 'Pinned to sidebar' : 'Unpinned');
    },
  });

  const all = workflows ?? [];
  const pinned = all.filter((w) => w.pinned);
  const candidates = all.filter((w) => !w.pinned);

  const goCreate = () => {
    toast.info('Create a new workflow by chatting with the Agent');
    void navigate({ to: '/agent' });
  };

  const addControl =
    candidates.length > 0 ? (
      <AddMenuButton label="Add workflow" alwaysVisible={pinned.length === 0}>
        <Menu.Label>Pin a workflow</Menu.Label>
        {candidates.map((w) => (
          <Menu.Item
            key={w.id}
            leftSection={<IconRepeat size={16} stroke={1.6} />}
            disabled={setPin.isPending}
            onClick={() => setPin.mutate({ id: w.id, pinned: true })}
          >
            <Text size="sm" truncate>
              {w.name}
            </Text>
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconSparkles size={16} stroke={1.6} />}
          onClick={goCreate}
        >
          New workflow with Agent
        </Menu.Item>
      </AddMenuButton>
    ) : (
      <AddActionButton
        label="Create a workflow with the Agent"
        alwaysVisible={pinned.length === 0}
        onClick={goCreate}
      />
    );

  return (
    <>
      <SectionHeading
        label="Workflows"
        addControl={addControl}
        manageTo="/workflows"
        manageLabel="Manage workflows"
      />
      <Stack gap={2} px="xs">
        {pinned.map((w) => (
          <PinnedRow
            key={w.id}
            onUnpin={() => setPin.mutate({ id: w.id, pinned: false })}
          >
            <NavLink
              renderRoot={(props) => (
                <Link
                  to="/workflows/$workflowId"
                  params={{ workflowId: w.id }}
                  {...props}
                />
              )}
              label={w.name}
              leftSection={<AppGlyph name={w.name} seed={w.id} size="sm" />}
              active={isActive(`/workflows/${w.id}`)}
              variant="light"
              pr={32}
            />
          </PinnedRow>
        ))}
      </Stack>
    </>
  );
}
