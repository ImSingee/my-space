import { Alert, Group } from '@mantine/core';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { IconInfoCircle } from '@tabler/icons-react';
import { Page } from '~components/app-shell/page';
import { AppGlyph } from '~components/apps/app-glyph';
import { StatusBadge } from '~components/system/status-badge';
import { TriggerForm } from '~components/workflows/trigger-form';
import { WorkflowTabs } from '~components/workflows/workflow-tabs';
import { getWorkflow } from '~server/workflows';

export const Route = createFileRoute('/_app/workflows/$workflowId/')({
  loader: async ({ params }) => {
    const workflow = await getWorkflow({ data: params.workflowId });
    if (!workflow) throw notFound();
    return workflow;
  },
  component: WorkflowRunPage,
});

/**
 * The "run" surface (opened from the sidebar): just the inferred input form and
 * a Run button. Trigger configuration and run history live on the Manage page.
 */
function WorkflowRunPage() {
  const workflow = Route.useLoaderData();
  const isDeployed = workflow.status === 'deployed';

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
      description={workflow.description || `Workflow · ${workflow.id}`}
      actions={<WorkflowTabs id={workflow.id} active="run" />}
    >
      {isDeployed ? (
        <TriggerForm
          workflowId={workflow.id}
          inputSchema={workflow.inputSchema}
        />
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
