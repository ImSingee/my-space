/** Server-only: Git-backed source storage for Hatch apps. */
import {
  agentAppWorkDir,
  appDeployCheckoutDir,
  appRepoDir,
} from '~agent/paths';
import {
  DEPLOY_TAG_PREFIX,
  SOURCE_BRANCH,
  createGitSource,
  worktreeOrigin,
  type PublishedSource,
  type SourceCheckout,
} from '../source-git';

export const APP_SOURCE_BRANCH = SOURCE_BRANCH;
export { DEPLOY_TAG_PREFIX, worktreeOrigin };
export type { PublishedSource };

export type AppCheckout = Omit<SourceCheckout, 'id'> & { appId: string };

const core = createGitSource({
  noun: 'app',
  deployTool: 'deploy_app',
  repoDir: appRepoDir,
  deployCheckoutDir: appDeployCheckoutDir,
  agentCheckoutDir: agentAppWorkDir,
});

export const ensureAppRepo = core.ensureRepo;
export const appMasterCommit = core.masterCommit;
export const prepareDeployCheckout = core.prepareDeployCheckout;
export const assertDeployableWorktree = core.assertDeployableWorktree;
export const publishDeploymentSource = core.publishDeploymentSource;
export const deleteDeploymentTag = core.deleteDeploymentTag;
export const moveMasterToDeploymentTag = core.moveMasterToDeploymentTag;
export const exportAppMasterBundle = core.exportMasterBundle;
export const stageAppBundleCheckout = core.stageBundleCheckout;

export async function checkoutAppForAgent(
  sessionId: string,
  id: string,
): Promise<AppCheckout> {
  const { id: appId, ...rest } = await core.checkoutForAgent(sessionId, id);
  return { appId, ...rest };
}
