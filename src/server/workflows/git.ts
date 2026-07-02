/** Server-only: Git-backed source storage for Hatch workflows. */
import {
  agentWorkflowWorkDir,
  workflowDeployCheckoutDir,
  workflowRepoDir,
} from '~agent/paths';
import {
  DEPLOY_TAG_PREFIX,
  SOURCE_BRANCH,
  createGitSource,
  worktreeOrigin,
  type PublishedSource,
  type SourceCheckout,
} from '../source-git';

export const WORKFLOW_SOURCE_BRANCH = SOURCE_BRANCH;
export { DEPLOY_TAG_PREFIX, worktreeOrigin };
export type { PublishedSource };

export type WorkflowCheckout = Omit<SourceCheckout, 'id'> & {
  workflowId: string;
};

const core = createGitSource({
  noun: 'workflow',
  deployTool: 'deploy_workflow',
  repoDir: workflowRepoDir,
  deployCheckoutDir: workflowDeployCheckoutDir,
  agentCheckoutDir: agentWorkflowWorkDir,
});

export const ensureWorkflowRepo = core.ensureRepo;
export const workflowMasterCommit = core.masterCommit;
export const prepareDeployCheckout = core.prepareDeployCheckout;
export const assertDeployableWorktree = core.assertDeployableWorktree;
export const publishDeploymentSource = core.publishDeploymentSource;
export const deleteDeploymentTag = core.deleteDeploymentTag;
export const moveMasterToDeploymentTag = core.moveMasterToDeploymentTag;

export async function checkoutWorkflowForAgent(
  sessionId: string,
  id: string,
): Promise<WorkflowCheckout> {
  const { id: workflowId, ...rest } = await core.checkoutForAgent(
    sessionId,
    id,
  );
  return { workflowId, ...rest };
}
