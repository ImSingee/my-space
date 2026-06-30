/**
 * Server-only: resolve a top-level workflow's external invocation config.
 *
 * Shared by the app-platform so apps can call workflows through the existing
 * external workflow API (`POST /api/workflow-hooks/<id>?secret=`). A workflow is
 * only "callable" when it is deployed AND its current deployment has the webhook
 * trigger enabled with a provisioned secret — exactly the conditions the public
 * webhook route enforces — so this mirrors that gate in one place.
 */
import { db } from '~/db';
import { workflowWebhookUrl } from './manifest';

export type CallableWorkflow = {
  id: string;
  name: string;
  /** Per-workflow webhook secret used to authenticate external invocations. */
  secret: string;
  /** Platform-relative invocation path (no secret). */
  path: string;
};

/**
 * Return the invocation config for a workflow that can be triggered externally,
 * or null when it does not exist / is not deployed / has no enabled webhook.
 */
export async function getCallableWorkflow(
  id: string,
): Promise<CallableWorkflow | null> {
  const workflow = await db.query.workflows.findFirst({
    where: (s, { eq }) => eq(s.id, id),
    columns: {
      id: true,
      name: true,
      status: true,
      webhookSecret: true,
      currentDeploymentId: true,
    },
  });
  if (
    !workflow ||
    workflow.status !== 'deployed' ||
    !workflow.webhookSecret ||
    !workflow.currentDeploymentId
  ) {
    return null;
  }
  // The secret persists even if a later redeploy disables the webhook trigger,
  // so confirm the LIVE deployment still enables it (the public route checks the
  // same field, and would otherwise 404 the call).
  const deployment = await db.query.workflowDeployments.findFirst({
    where: (d, { eq }) => eq(d.id, workflow.currentDeploymentId as string),
    columns: { manifestNormalized: true },
  });
  const manifest = deployment?.manifestNormalized as {
    triggers?: { webhook?: { enabled?: boolean } };
  } | null;
  if (!manifest?.triggers?.webhook?.enabled) return null;

  return {
    id: workflow.id,
    name: workflow.name,
    secret: workflow.webhookSecret,
    path: workflowWebhookUrl(workflow.id),
  };
}
