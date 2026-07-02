import {
  ActionIcon,
  Anchor,
  Box,
  Divider,
  Group,
  Menu,
  Stack,
  Text,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  createFileRoute,
  notFound,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import {
  IconArchive,
  IconArchiveOff,
  IconDotsVertical,
  IconFileCode,
  IconPin,
  IconPinnedOff,
  IconTrash,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { toast } from 'sonner';
import { Page } from '~components/app-shell/page';
import { AppGlyph } from '~components/apps/app-glyph';
import { WorkflowDeploymentHistory } from '~components/workflows/deployment-history';
import { Field } from '~components/system/field';
import { StatusBadge } from '~components/system/status-badge';
import { WorkflowTriggersPanel } from '~components/workflows/triggers-panel';
import { WorkflowTabs } from '~components/workflows/workflow-tabs';
import {
  workflowOpsQueryOptions,
  workflowsQueryOptions,
} from '~queries/workflows';
import {
  archiveWorkflowFn,
  deleteWorkflowFn,
  getWorkflow,
  setWorkflowPinFn,
} from '~server/workflows';

export const Route = createFileRoute('/_app/workflows/$workflowId/manage')({
  loader: async ({ params }) => {
    const workflow = await getWorkflow({ data: params.workflowId });
    if (!workflow) throw notFound();
    return workflow;
  },
  component: WorkflowManagePage,
});

function WorkflowManagePage() {
  const workflow = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const isArchived = workflow.status === 'archived';
  const isPinned = Boolean(workflow.pinned);
  const hasCurrent = Boolean(workflow.currentDeploymentId);

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      archiveWorkflowFn({ data: { id: workflow.id, archived } }),
    onSuccess: (_result, archived) => {
      toast.success(archived ? 'Workflow archived' : 'Workflow restored');
      // Archiving flips webhook/cron availability; refresh the ops query the
      // Triggers panel reads so it doesn't keep showing a now-dead webhook.
      void queryClient.invalidateQueries(workflowOpsQueryOptions(workflow.id));
      void queryClient.invalidateQueries(workflowsQueryOptions);
      void router.invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteWorkflowFn({ data: workflow.id }),
    onSuccess: () => {
      toast.success(`Deleted ${workflow.name}`);
      void queryClient.invalidateQueries(workflowsQueryOptions);
      void navigate({ to: '/workflows' });
    },
  });

  const pin = useMutation({
    mutationFn: (pinned: boolean) =>
      setWorkflowPinFn({ data: { id: workflow.id, pinned } }),
    onSuccess: (_result, pinned) => {
      toast.success(pinned ? 'Pinned to sidebar' : 'Removed from sidebar');
      void queryClient.invalidateQueries(workflowsQueryOptions);
      void router.invalidate();
    },
  });

  const confirmDelete = () =>
    modals.openConfirmModal({
      title: `Delete ${workflow.name}?`,
      children: (
        <Text size="sm">
          This permanently removes the workflow, all deployments, and its run
          history. This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete workflow', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(),
    });

  return (
    <Page
      title={
        <Group gap="sm" align="center" wrap="nowrap">
          <AppGlyph name={workflow.name} seed={workflow.id} size="md" />
          {workflow.name}
          <StatusBadge status={workflow.status} />
        </Group>
      }
      description={workflow.description || `Workflow · ${workflow.id}`}
      actions={
        <>
          <WorkflowTabs id={workflow.id} active="manage" />
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="default" size="lg" aria-label="More actions">
                <IconDotsVertical size={18} stroke={1.8} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Download</Menu.Label>
              <Menu.Item
                leftSection={<IconFileCode size={16} />}
                component="a"
                href={`/api/workflows/${workflow.id}/download?deployment=${
                  workflow.currentDeploymentId ?? ''
                }`}
                download
                disabled={!hasCurrent}
              >
                Live bundle (.js)
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                leftSection={
                  isPinned ? <IconPinnedOff size={16} /> : <IconPin size={16} />
                }
                onClick={() => pin.mutate(!isPinned)}
              >
                {isPinned ? 'Remove from sidebar' : 'Pin to sidebar'}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                leftSection={
                  isArchived ? (
                    <IconArchiveOff size={16} />
                  ) : (
                    <IconArchive size={16} />
                  )
                }
                onClick={() => archive.mutate(!isArchived)}
              >
                {isArchived ? 'Restore from archive' : 'Archive'}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={confirmDelete}
              >
                Delete workflow
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </>
      }
    >
      <Stack gap="xl">
        <Box component="section">
          <Text fw={600} fz="lg" mb="md">
            Overview
          </Text>
          <Stack gap="sm">
            <Field
              label="Identifier"
              value={workflow.id}
              mono
              copyValue={workflow.id}
            />
            <Field
              label="Updated"
              value={dayjs(workflow.updatedAt).format('YYYY-MM-DD HH:mm')}
            />
          </Stack>
          <Text size="sm" c="dimmed" mt="lg">
            Continue editing this workflow from the{' '}
            <Anchor component={Link} to="/agent">
              Agent
            </Anchor>
            .
          </Text>
        </Box>

        <Divider />

        <WorkflowTriggersPanel workflowId={workflow.id} />

        <Divider />

        <WorkflowDeploymentHistory workflowId={workflow.id} />
      </Stack>
    </Page>
  );
}
