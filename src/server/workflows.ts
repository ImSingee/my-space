import { createServerFn } from '@tanstack/react-start';
import { db } from '~/db';
import type { JsonObject, WorkflowStatus } from '~/db/schema';
import { authMiddleware } from './auth';
import { workflowWebhookUrl } from './workflows/manifest';

/** Public list projection: never includes `webhookSecret`/`repoPath`/manifest. */
export type WorkflowListItem = {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

export const listWorkflows = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<WorkflowListItem[]> => {
    // Opportunistically (re)start the workflow cron scheduler so schedules
    // survive a platform restart without requiring a redeploy.
    void import('./workflows/scheduler').then((m) =>
      m.ensureWorkflowScheduler(),
    );
    // Select explicit columns: the raw row carries `webhookSecret`, `repoPath`,
    // and source metadata the list/sidebar UI never needs and that must not be
    // shipped to the browser. The webhook secret is disclosed only by the
    // dedicated ops endpoint, and only for a live deployment.
    const rows = await db.query.workflows.findMany({
      orderBy: (s, { desc }) => [desc(s.updatedAt)],
      columns: {
        id: true,
        name: true,
        description: true,
        status: true,
        pinned: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  });

/** Public detail projection for the manage/run pages (no secret/repo fields). */
export type WorkflowDetail = {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  pinned: boolean;
  currentDeploymentId: string | null;
  currentSourceCommit: string | null;
  inputSchema: JsonObject | null;
  createdAt: string;
  updatedAt: string;
};

export const getWorkflow = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<WorkflowDetail | null> => {
    const row = await db.query.workflows.findFirst({
      where: (s, { eq: e }) => e(s.id, id),
      columns: {
        id: true,
        name: true,
        description: true,
        status: true,
        pinned: true,
        currentDeploymentId: true,
        currentSourceCommit: true,
        inputSchema: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!row) return null;
    return {
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });

export type WorkflowRow = NonNullable<Awaited<ReturnType<typeof getWorkflow>>>;

export const listWorkflowDeployments = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const { listWorkflowDeployments: list } =
      await import('./workflows/manage');
    return list(id);
  });

export const getWorkflowDeploymentBuildLog = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((input: { id: string; deploymentId: string }) => input)
  .handler(async ({ data }) => {
    const { workflowDeploymentBuildLog } = await import('./workflows/manage');
    return workflowDeploymentBuildLog(data.id, data.deploymentId);
  });

export const rollbackWorkflowFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; deploymentId: string }) => input)
  .handler(async ({ data }) => {
    const { rollbackWorkflow } = await import('./workflows/manage');
    return rollbackWorkflow(data.id, data.deploymentId);
  });

export const archiveWorkflowFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; archived: boolean }) => input)
  .handler(async ({ data }) => {
    const { setWorkflowArchived } = await import('./workflows/manage');
    return setWorkflowArchived(data.id, data.archived);
  });

export const deleteWorkflowFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const { deleteWorkflow } = await import('./workflows/manage');
    return deleteWorkflow(id);
  });

export const setWorkflowPinFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
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
  .middleware([authMiddleware])
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
  .middleware([authMiddleware])
  .validator((input: { id: string; input?: unknown }) => input)
  .handler(async ({ data }) => {
    const { startWorkflowRun } = await import('./workflows/execute');
    return startWorkflowRun(data.id, {
      trigger: 'manual',
      input: data.input ?? {},
    });
  });

export const listWorkflowRuns = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const { listWorkflowRuns: list } = await import('./workflows/manage');
    return list(id);
  });

export const listAllWorkflowRuns = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async () => {
    const { listRecentWorkflowRuns } = await import('./workflows/manage');
    return listRecentWorkflowRuns();
  });

export const getWorkflowRun = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((runId: string) => runId)
  .handler(async ({ data: runId }) => {
    const { getWorkflowRun: get } = await import('./workflows/manage');
    return get(runId);
  });

export const cancelWorkflowRunFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((runId: string) => runId)
  .handler(async ({ data: runId }) => {
    const { cancelWorkflowRun } = await import('./workflows/execute');
    return cancelWorkflowRun(runId);
  });
