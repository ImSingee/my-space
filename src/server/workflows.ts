import { createServerFn } from '@tanstack/react-start';
import { db } from '~/db';
import { workflowWebhookUrl } from './workflows/manifest';

export const listWorkflows = createServerFn({ method: 'GET' }).handler(
  async () => {
    // Opportunistically (re)start the workflow cron scheduler so schedules
    // survive a platform restart without requiring a redeploy.
    void import('./workflows/scheduler').then((m) =>
      m.ensureWorkflowScheduler(),
    );
    return db.query.workflows.findMany({
      orderBy: (s, { desc }) => [desc(s.updatedAt)],
    });
  },
);

export const getWorkflow = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const row = await db.query.workflows.findFirst({
      where: (s, { eq: e }) => e(s.id, id),
    });
    return row ?? null;
  });

export type WorkflowRow = NonNullable<Awaited<ReturnType<typeof getWorkflow>>>;

export const listWorkflowDeployments = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const { listWorkflowDeployments: list } =
      await import('./workflows/manage');
    return list(id);
  });

export const getWorkflowDeploymentBuildLog = createServerFn({ method: 'GET' })
  .validator((input: { id: string; deploymentId: string }) => input)
  .handler(async ({ data }) => {
    const { workflowDeploymentBuildLog } = await import('./workflows/manage');
    return workflowDeploymentBuildLog(data.id, data.deploymentId);
  });

export const rollbackWorkflowFn = createServerFn({ method: 'POST' })
  .validator((input: { id: string; deploymentId: string }) => input)
  .handler(async ({ data }) => {
    const { rollbackWorkflow } = await import('./workflows/manage');
    return rollbackWorkflow(data.id, data.deploymentId);
  });

export const archiveWorkflowFn = createServerFn({ method: 'POST' })
  .validator((input: { id: string; archived: boolean }) => input)
  .handler(async ({ data }) => {
    const { setWorkflowArchived } = await import('./workflows/manage');
    return setWorkflowArchived(data.id, data.archived);
  });

export const deleteWorkflowFn = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const { deleteWorkflow } = await import('./workflows/manage');
    return deleteWorkflow(id);
  });

export const setWorkflowPinFn = createServerFn({ method: 'POST' })
  .validator((input: { id: string; pinned: boolean }) => input)
  .handler(async ({ data }) => {
    const { eq } = await import('drizzle-orm');
    const { schema } = await import('~/db');
    await db
      .update(schema.workflows)
      .set({ pinned: data.pinned })
      .where(eq(schema.workflows.id, data.id));
    return { pinned: data.pinned };
  });

/* ------------------------------- triggers --------------------------------- */

export type WorkflowCronJobView = {
  name: string;
  schedule: string;
  nextRun: string | null;
};

export type WorkflowOps = {
  status: string;
  webhook: { enabled: boolean; url: string | null; secret: string | null };
  cron: { enabled: boolean; jobs: WorkflowCronJobView[] };
};

export const getWorkflowOps = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<WorkflowOps> => {
    const workflow = await db.query.workflows.findFirst({
      where: (s, { eq: e }) => e(s.id, id),
    });
    if (!workflow) {
      return {
        status: 'draft',
        webhook: { enabled: false, url: null, secret: null },
        cron: { enabled: false, jobs: [] },
      };
    }
    const { listWorkflowCronJobs } = await import('./workflows/scheduler');
    const jobs = await listWorkflowCronJobs(id);
    let webhookEnabled = false;
    // Only advertise the webhook when the workflow is actually live: the public
    // handler rejects anything other than `deployed`, so an archived workflow
    // must not surface a URL/secret that would 404.
    if (workflow.status === 'deployed' && workflow.currentDeploymentId) {
      const deployment = await db.query.workflowDeployments.findFirst({
        where: (d, { eq: e }) =>
          e(d.id, workflow.currentDeploymentId as string),
      });
      const manifest = deployment?.manifestNormalized as {
        triggers?: { webhook?: { enabled?: boolean } };
      } | null;
      webhookEnabled = Boolean(manifest?.triggers?.webhook?.enabled);
    }
    return {
      status: workflow.status,
      webhook: {
        enabled: webhookEnabled,
        url: webhookEnabled ? workflowWebhookUrl(id) : null,
        secret: webhookEnabled ? workflow.webhookSecret : null,
      },
      cron: { enabled: jobs.length > 0, jobs },
    };
  });

/* --------------------------------- runs ----------------------------------- */

export const runWorkflowFn = createServerFn({ method: 'POST' })
  .validator((input: { id: string; input?: unknown }) => input)
  .handler(async ({ data }) => {
    const { startWorkflowRun } = await import('./workflows/execute');
    return startWorkflowRun(data.id, {
      trigger: 'manual',
      input: data.input ?? {},
    });
  });

export const listWorkflowRuns = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const { listWorkflowRuns: list } = await import('./workflows/manage');
    return list(id);
  });

export const listAllWorkflowRuns = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { listRecentWorkflowRuns } = await import('./workflows/manage');
    return listRecentWorkflowRuns();
  },
);

export const getWorkflowRun = createServerFn({ method: 'GET' })
  .validator((runId: string) => runId)
  .handler(async ({ data: runId }) => {
    const { getWorkflowRun: get } = await import('./workflows/manage');
    return get(runId);
  });

export const cancelWorkflowRunFn = createServerFn({ method: 'POST' })
  .validator((runId: string) => runId)
  .handler(async ({ data: runId }) => {
    const { cancelWorkflowRun } = await import('./workflows/execute');
    return cancelWorkflowRun(runId);
  });
