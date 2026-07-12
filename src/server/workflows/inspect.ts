/** Server-only: read-only workflow views for the Agent (list + detail). */
import { inArray } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { WorkflowStatus } from '~/db/schema';
import type { NormalizedWorkflowManifest } from './manifest';
import { listWorkflowDeployments, listWorkflowRuns } from './manage';
import { listWorkflowCronJobs } from './scheduler';

export type WorkflowSummaryForAgent = {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  liveVersion: number | null;
  webhook: boolean;
  cronCount: number;
};

export async function listWorkflowsForAgent(): Promise<
  WorkflowSummaryForAgent[]
> {
  const rows = await db.query.workflows.findMany({
    orderBy: (s, { desc }) => [desc(s.updatedAt)],
  });
  const deploymentIds = rows
    .map((w) => w.currentDeploymentId)
    .filter((id): id is string => Boolean(id));
  const deployments =
    deploymentIds.length === 0
      ? []
      : await db.query.workflowDeployments.findMany({
          where: inArray(schema.workflowDeployments.id, deploymentIds),
          columns: { id: true, version: true, manifestNormalized: true },
        });
  const deploymentById = new Map(deployments.map((d) => [d.id, d]));
  const result: WorkflowSummaryForAgent[] = [];
  for (const w of rows) {
    let liveVersion: number | null = null;
    let webhook = false;
    let cronCount = 0;
    if (w.currentDeploymentId) {
      const deployment = deploymentById.get(w.currentDeploymentId);
      liveVersion = deployment?.version ?? null;
      const manifest =
        deployment?.manifestNormalized as NormalizedWorkflowManifest | null;
      webhook = Boolean(manifest?.triggers?.webhook?.enabled);
      cronCount = manifest?.triggers?.cron?.length ?? 0;
    }
    result.push({
      id: w.id,
      name: w.name,
      description: w.description,
      status: w.status,
      liveVersion,
      webhook,
      cronCount,
    });
  }
  return result;
}

export type WorkflowDetailForAgent = {
  id: string;
  createdAt: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  liveVersion: number | null;
  inputSchema: unknown;
  webhook: { enabled: boolean; url: string | null };
  cron: { name: string; schedule: string; nextRun: string | null }[];
  recentRuns: {
    id: string;
    status: string;
    trigger: string;
    createdAt: string;
  }[];
  deployments: { version: number; message: string | null; createdAt: string }[];
};

export async function getWorkflowDetailForAgent(
  id: string,
): Promise<WorkflowDetailForAgent | null> {
  const w = await db.query.workflows.findFirst({
    where: (s, { eq }) => eq(s.id, id),
  });
  if (!w) return null;

  let liveVersion: number | null = null;
  let webhook: { enabled: boolean; url: string | null } = {
    enabled: false,
    url: null,
  };
  if (w.currentDeploymentId) {
    const deployment = await db.query.workflowDeployments.findFirst({
      where: (d, { eq }) => eq(d.id, w.currentDeploymentId as string),
    });
    liveVersion = deployment?.version ?? null;
    const manifest =
      deployment?.manifestNormalized as NormalizedWorkflowManifest | null;
    if (manifest?.triggers?.webhook) {
      webhook = manifest.triggers.webhook;
    }
  }

  const cron = await listWorkflowCronJobs(id);
  const runs = await listWorkflowRuns(id, 10);
  const deployments = await listWorkflowDeployments(id);

  return {
    id: w.id,
    createdAt: w.createdAt.toISOString(),
    name: w.name,
    description: w.description,
    status: w.status,
    liveVersion,
    inputSchema: w.inputSchema ?? null,
    webhook,
    cron,
    recentRuns: runs.map((r) => ({
      id: r.id,
      status: r.status,
      trigger: r.trigger,
      createdAt: r.createdAt,
    })),
    deployments: deployments.map((d) => ({
      version: d.version,
      message: d.message,
      createdAt: d.createdAt,
    })),
  };
}
