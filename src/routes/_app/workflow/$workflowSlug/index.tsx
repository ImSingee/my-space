import { Alert, Group, Stack } from '@mantine/core';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { IconInfoCircle } from '@tabler/icons-react';
import { Page } from '~components/app-shell/page';
import { AppGlyph } from '~components/apps/app-glyph';
import { StatusBadge } from '~components/system/status-badge';
import { TriggerForm } from '~components/workflows/trigger-form';
import { WorkflowCompatibilityNotice } from '~components/workflows/workflow-compatibility-notice';
import { WorkflowTabs } from '~components/workflows/workflow-tabs';
import { getWorkflowBySlug } from '~server/workflows';

export const Route = createFileRoute('/_app/workflow/$workflowSlug/')({
  loader: async ({ params }) => {
    const workflow = await getWorkflowBySlug({ data: params.workflowSlug });
    if (!workflow) throw notFound();
    return workflow;
  },
  component: WorkflowRunPage,
});

/**
 * The "run" surface (opened from the sidebar): just the inferred input form and
 * a Run button. Trigger configuration and run history live on the Manage page.
 */
export function WorkflowRunPage() {
  const workflow = Route.useLoaderData();
  const isDeployed = workflow.status === 'deployed';
  const runtimeSupported = workflow.compatibility?.isSupported === true;

  return (
    <Page
      size={680}
      title={
        <Group gap="sm" align="center" wrap="nowrap">
          <AppGlyph name={workflow.name} seed={workflow.id} size="md" />
          {workflow.name}
          <StatusBadge status={workflow.status} />
        </Group>
      }
      description={workflow.description || `Workflow · ${workflow.slug}`}
      actions={<WorkflowTabs slug={workflow.slug} active="run" />}
    >
      {isDeployed && runtimeSupported ? (
        <TriggerForm
          workflowId={workflow.id}
          workflowSlug={workflow.slug}
          inputSchema={workflow.inputSchema}
        />
      ) : isDeployed ? (
        <Stack>
          <WorkflowCompatibilityNotice compatibility={workflow.compatibility} />
          {!workflow.compatibility ? (
            <Alert
              color="red"
              variant="light"
              icon={<IconInfoCircle size={16} />}
            >
              The active deployment record is unavailable. Redeploy this
              Workflow from the Agent before running it.
            </Alert>
          ) : null}
        </Stack>
      ) : (
        <Alert
          color="ember"
          variant="light"
          icon={<IconInfoCircle size={16} />}
        >
          This workflow isn&apos;t deployed yet. Deploy it from the Agent to
          enable manual, cron, and webhook triggers.
        </Alert>
      )}
    </Page>
  );
}
