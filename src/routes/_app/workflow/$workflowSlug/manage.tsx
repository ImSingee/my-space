import {
  ActionIcon,
  Anchor,
  Box,
  Divider,
  Group,
  Menu,
  Stack,
  Text,
  TextInput,
  Tooltip,
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
  IconCheck,
  IconDotsVertical,
  IconFileCode,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { WORKFLOW_SLUG_MAX_LENGTH } from '~/workflow-identity';
import { Page } from '~components/app-shell/page';
import { AppGlyph } from '~components/apps/app-glyph';
import { WorkflowDeploymentHistory } from '~components/workflows/deployment-history';
import { WorkflowNetworkPermissionsPanel } from '~components/workflows/network-permissions-panel';
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
  getWorkflowBySlug,
  setWorkflowPinFn,
  setWorkflowSlugFn,
} from '~server/workflows';

export const Route = createFileRoute('/_app/workflow/$workflowSlug/manage')({
  loader: async ({ params }) => {
    const workflow = await getWorkflowBySlug({ data: params.workflowSlug });
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
      description={workflow.description || `Workflow · ${workflow.slug}`}
      actions={
        <>
          <WorkflowTabs slug={workflow.slug} active="manage" />
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
                href={`/api/workflow/${workflow.id}/download?deployment=${
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
            <WorkflowSlugField id={workflow.id} slug={workflow.slug} />
            <Field
              label="Workflow ID"
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

        <WorkflowNetworkPermissionsPanel workflowId={workflow.id} />

        <Divider />

        <WorkflowTriggersPanel workflowId={workflow.id} />

        <Divider />

        <WorkflowDeploymentHistory workflowId={workflow.id} />
      </Stack>
    </Page>
  );
}

function WorkflowSlugField({ id, slug }: { id: string; slug: string }) {
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(slug);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = useMutation({
    mutationFn: (next: string) =>
      setWorkflowSlugFn({ data: { id, slug: next } }),
    onSuccess: (result) => {
      toast.success(`URL slug is now "${result.slug}"`);
      setEditing(false);
      void navigate({
        to: '/workflow/$workflowSlug/manage',
        params: { workflowSlug: result.slug },
        search: true,
        hash: true,
        replace: true,
      }).then(async () => {
        await queryClient.invalidateQueries(workflowsQueryOptions);
        await router.invalidate();
      });
    },
  });

  const submit = () => {
    const next = draft.trim();
    if (next === slug) {
      setEditing(false);
      return;
    }
    save.mutate(next);
  };

  return (
    <Group gap="md" wrap="nowrap" align="center">
      <Text size="sm" c="dimmed" style={{ width: 96, flex: 'none' }}>
        URL slug
      </Text>
      {editing ? (
        <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            ref={inputRef}
            value={draft}
            maxLength={WORKFLOW_SLUG_MAX_LENGTH}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
              if (event.key === 'Escape') {
                setDraft(slug);
                setEditing(false);
              }
            }}
            size="xs"
            disabled={save.isPending}
            styles={{ input: { fontFamily: 'monospace' } }}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Tooltip label="Save" withArrow position="top">
            <ActionIcon
              variant="light"
              color="green"
              onClick={submit}
              loading={save.isPending}
              aria-label="Save slug"
            >
              <IconCheck size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Cancel" withArrow position="top">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => {
                setDraft(slug);
                setEditing(false);
              }}
              disabled={save.isPending}
              aria-label="Cancel"
            >
              <IconX size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      ) : (
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" ff="monospace" truncate>
            {slug}
          </Text>
          <Tooltip label="Edit slug" withArrow position="top">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => {
                setDraft(slug);
                setEditing(true);
              }}
              aria-label="Edit slug"
            >
              <IconPencil size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
      )}
    </Group>
  );
}
