/** Server-only: Git-backed source storage for Hatch workflows. */
import { workflowDeployCheckoutDir, workflowRepoDir } from '~agent/paths';
import {
  DEPLOY_TAG_PREFIX,
  SOURCE_BRANCH,
  createGitSource,
  type PublishedSource,
} from '../source-git';

export const WORKFLOW_SOURCE_BRANCH = SOURCE_BRANCH;
export { DEPLOY_TAG_PREFIX };
export type { PublishedSource };

const core = createGitSource({
  noun: 'workflow',
  deployTool: 'deploy_workflow',
  repoDir: workflowRepoDir,
  deployCheckoutDir: workflowDeployCheckoutDir,
});

export const ensureWorkflowRepo = core.ensureRepo;
export const workflowMasterCommit = core.masterCommit;
export const prepareDeployCheckout = core.prepareDeployCheckout;
export const assertDeployableWorktree = core.assertDeployableWorktree;
export const publishDeploymentSource = core.publishDeploymentSource;
export const deleteDeploymentTag = core.deleteDeploymentTag;
export const moveMasterToDeploymentTag = core.moveMasterToDeploymentTag;
export const exportWorkflowMasterBundle = core.exportMasterBundle;
export const stageWorkflowBundleCheckout = core.stageBundleCheckout;
