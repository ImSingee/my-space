/**
 * Server-only: resolve a top-level workflow's external invocation config.
 *
 * Shared by the app-platform so apps can call workflows through the existing
 * external workflow API (`POST /api/workflow/<id>/run?secret=`). A workflow is
 * only externally addressable when it is deployed AND its current deployment
 * has the webhook trigger enabled with a provisioned secret. Compatibility is
 * reported separately so callers can preserve the target while the public
 * webhook route remains the final runtime gate.
 */
import { db } from '~/db';
import {
  type WorkflowCompatibility,
  workflowCompatibility,
} from '~/workflow-compatibility';
import { workflowWebhookUrl } from './manifest';

export type CallableWorkflow = {
  id: string;
  name: string;
  /** Per-workflow webhook secret used to authenticate external invocations. */
  secret: string;
  /** Platform-relative invocation path (no secret). */
  path: string;
};

export type WorkflowCallability =
  | { state: 'callable'; workflow: CallableWorkflow }
  | { state: 'unavailable' }
  | {
      state: 'unsupported';
      workflow: CallableWorkflow;
      compatibility: WorkflowCompatibility;
    };

/** Preserve an unsupported deployment separately from ordinary unavailability. */
export async function getWorkflowCallability(
  id: string,
): Promise<WorkflowCallability> {
  const workflow = await db.query.workflows.findFirst({
    where: { id },
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
    return { state: 'unavailable' };
  }
  // The secret persists even if a later redeploy disables the webhook trigger,
  // so confirm the LIVE deployment still enables it (the public route checks the
  // same field, and would otherwise 404 the call).
  const deployment = await db.query.workflowDeployments.findFirst({
    where: { id: workflow.currentDeploymentId as string },
    columns: { manifestNormalized: true, compatibilityVersion: true },
  });
  if (!deployment) return { state: 'unavailable' };
  const manifest = deployment?.manifestNormalized as {
    triggers?: { webhook?: { enabled?: boolean } };
  } | null;
  if (!manifest?.triggers?.webhook?.enabled) {
    return { state: 'unavailable' };
  }

  const compatibility = workflowCompatibility(deployment.compatibilityVersion);
  const invocationTarget: CallableWorkflow = {
    id: workflow.id,
    name: workflow.name,
    secret: workflow.webhookSecret,
    path: workflowWebhookUrl(workflow.id),
  };
  if (!compatibility.isSupported) {
    return {
      state: 'unsupported',
      workflow: invocationTarget,
      compatibility,
    };
  }

  return { state: 'callable', workflow: invocationTarget };
}
