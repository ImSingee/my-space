/** Server-only: canonical workspace paths used by the Agent, builder, runtime. */
import path from 'node:path';

export const REPO_ROOT = process.cwd();
export const WORKSPACE_ROOT = path.resolve(REPO_ROOT, 'workspace');
/** Legacy app source trees used before Git-backed app repositories. */
export const APPS_DIR = path.resolve(WORKSPACE_ROOT, 'apps');
/** Built artifacts (live, served): workspace/builds/<id>/{app,widgets}. */
export const BUILDS_DIR = path.resolve(WORKSPACE_ROOT, 'builds');
/** Temporary build inputs copied from clean source worktrees. */
export const BUILD_WORK_DIR = path.resolve(WORKSPACE_ROOT, 'build-work');
/** Legacy per-deployment build snapshots used before artifact records. */
export const VERSIONS_DIR = path.resolve(WORKSPACE_ROOT, 'versions');
/** Git bare repositories: workspace/repos/<id>.git. */
export const REPOS_DIR = path.resolve(WORKSPACE_ROOT, 'repos');
/** Persistent Agent work roots: workspace/agents/<sessionId>/work/<appId>. */
export const AGENTS_DIR = path.resolve(WORKSPACE_ROOT, 'agents');
/** Server-managed source checkouts used for non-Agent deploys. */
export const CHECKOUTS_DIR = path.resolve(WORKSPACE_ROOT, 'checkouts');
/** Deploy artifacts, one dir per deployment id (tagged deploy/v<version>). */
export const ARTIFACTS_DIR = path.resolve(WORKSPACE_ROOT, 'artifacts');
/** Persistent per-app blob storage: workspace/storage/<id>/<key>. */
export const STORAGE_DIR = path.resolve(WORKSPACE_ROOT, 'storage');
/** Markdown skills available to the Agent. */
export const SKILLS_DIR = path.resolve(REPO_ROOT, 'skills');
/** App scaffolding template. */
export const TEMPLATES_DIR = path.resolve(REPO_ROOT, 'templates');

export function appSrcDir(id: string): string {
  return path.resolve(APPS_DIR, id);
}

export function appRepoDir(id: string): string {
  return path.resolve(REPOS_DIR, `${id}.git`);
}

export function agentWorkDir(sessionId: string): string {
  return path.resolve(AGENTS_DIR, sessionId, 'work');
}

export function agentAppWorkDir(sessionId: string, id: string): string {
  return path.resolve(agentWorkDir(sessionId), id);
}

export function appDeployCheckoutDir(id: string): string {
  return path.resolve(CHECKOUTS_DIR, id, 'deploy');
}

export function appBuildDir(id: string): string {
  return path.resolve(BUILDS_DIR, id);
}

/** Snapshot directory for a specific deployment (used for rollback). */
export function appVersionsDir(id: string): string {
  return path.resolve(VERSIONS_DIR, id);
}

export function deploymentBuildDir(id: string, deploymentId: string): string {
  return path.resolve(VERSIONS_DIR, id, deploymentId);
}

export function appArtifactsDir(id: string): string {
  return path.resolve(ARTIFACTS_DIR, id);
}

export function deploymentArtifactDir(
  id: string,
  deploymentId: string,
): string {
  return path.resolve(ARTIFACTS_DIR, id, deploymentId);
}

/** Persistent storage root for an app's blobs. */
export function appStorageDir(id: string): string {
  return path.resolve(STORAGE_DIR, id);
}

/** ================== workflows ================== */
/**
 * Workflows mirror apps but live in their own namespaces so an app and a
 * workflow may share a slug without colliding on disk. The Agent worktree is
 * the one exception — both appear as `<id>/` under the chat work root, so the
 * Git layer guards against a slug already checked out for the other kind.
 */

/** Git bare repositories for workflows: workspace/workflow-repos/<id>.git. */
export const WORKFLOW_REPOS_DIR = path.resolve(
  WORKSPACE_ROOT,
  'workflow-repos',
);
/** Temporary build inputs copied from clean workflow source worktrees. */
export const WORKFLOW_BUILD_WORK_DIR = path.resolve(
  WORKSPACE_ROOT,
  'workflow-build-work',
);
/** Deploy artifacts (bundled single-file program), one dir per deployment id. */
export const WORKFLOW_ARTIFACTS_DIR = path.resolve(
  WORKSPACE_ROOT,
  'workflow-artifacts',
);
/** Live bundle executed on trigger: workspace/workflow-current/<id>/workflow.js. */
export const WORKFLOW_CURRENT_DIR = path.resolve(
  WORKSPACE_ROOT,
  'workflow-current',
);
/** Server-managed workflow source checkouts used for non-Agent deploys. */
export const WORKFLOW_CHECKOUTS_DIR = path.resolve(
  WORKSPACE_ROOT,
  'workflow-checkouts',
);

export function workflowRepoDir(id: string): string {
  return path.resolve(WORKFLOW_REPOS_DIR, `${id}.git`);
}

/** Agent worktree for a workflow (shares the chat work root with apps). */
export function agentWorkflowWorkDir(sessionId: string, id: string): string {
  return path.resolve(agentWorkDir(sessionId), id);
}

export function workflowDeployCheckoutDir(id: string): string {
  return path.resolve(WORKFLOW_CHECKOUTS_DIR, id, 'deploy');
}

export function workflowArtifactsDir(id: string): string {
  return path.resolve(WORKFLOW_ARTIFACTS_DIR, id);
}

export function workflowDeploymentArtifactDir(
  id: string,
  deploymentId: string,
): string {
  return path.resolve(WORKFLOW_ARTIFACTS_DIR, id, deploymentId);
}

/** Live directory holding the current bundled program for a workflow. */
export function workflowCurrentDir(id: string): string {
  return path.resolve(WORKFLOW_CURRENT_DIR, id);
}
