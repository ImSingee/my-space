/** Server-only: canonical workspace paths used by the Agent, builder, runtime. */
import path from 'node:path';

export const REPO_ROOT = process.cwd();
/**
 * Runtime data root: agent-authored app/workflow sources, Git repos, build
 * artifacts, per-app storage and agent worktrees. Defaults to `<repo>/workspace`
 * (matching the Docker volume mount). Set HATCH_DATA_DIR to relocate it — e.g.
 * a sibling directory outside the repo in local dev so the checkout stays free
 * of runtime data. Relative values resolve against the server's working
 * directory; absolute values are used as-is.
 */
export const WORKSPACE_ROOT = path.resolve(
  REPO_ROOT,
  process.env.HATCH_DATA_DIR ?? 'workspace',
);
/**
 * Platform-private staging for generated App SDK generations. This must stay
 * outside Agent-owned worktrees while remaining on the workspace filesystem
 * so the final directory install can be atomic.
 */
export const HATCH_SDK_STAGING_DIR = path.resolve(
  WORKSPACE_ROOT,
  '.hatch-sdk-staging',
);
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
/** Persistent Agent session roots (namespaced work, bundles, runner metadata). */
export const AGENTS_DIR = path.resolve(WORKSPACE_ROOT, 'agents');
/**
 * Root of per-session sandbox homes. Each child is private to one Agent
 * identity; sharing a HOME would let one chat read another chat's tool caches
 * and credentials.
 */
export const AGENT_HOME_DIR = path.resolve(WORKSPACE_ROOT, 'agent-home');
/** Root-only quarantine for credentials left by the legacy shared Agent HOME. */
export const AGENT_LEGACY_HOME_DIR = path.resolve(
  WORKSPACE_ROOT,
  'agent-home-legacy',
);
/** Root-owned persistent allocation of Linux uid/gid pairs to sessions. */
export const AGENT_IDENTITIES_PATH = path.resolve(
  WORKSPACE_ROOT,
  'agent-identities.json',
);
/** Cross-process lock directory protecting Agent identity allocation. */
export const AGENT_IDENTITIES_LOCK_PATH = path.resolve(
  WORKSPACE_ROOT,
  'agent-identities.lock',
);
/** Server-managed source checkouts used for non-Agent deploys. */
export const CHECKOUTS_DIR = path.resolve(WORKSPACE_ROOT, 'checkouts');
/** Deploy artifacts, one dir per deployment id (tagged deploy/v<version>). */
export const ARTIFACTS_DIR = path.resolve(WORKSPACE_ROOT, 'artifacts');
/** Private persistent directories for storage-capable app backends. */
export const STORAGE_DIR = path.resolve(WORKSPACE_ROOT, 'storage');
/** Original non-image files uploaded in Agent chats (Platform-side only). */
export const AGENT_ATTACHMENTS_DIR = path.resolve(
  WORKSPACE_ROOT,
  'agent-attachments',
);
/** Markdown skills available to the Agent. */
export const SKILLS_DIR = path.resolve(REPO_ROOT, 'skills');
/** App scaffolding template. */
export const TEMPLATES_DIR = path.resolve(REPO_ROOT, 'templates');

function isWellFormed(value: string): boolean {
  return (
    value as string & {
      isWellFormed(): boolean;
    }
  ).isWellFormed();
}

export function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    isWellFormed(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    }) &&
    path.basename(value) === value
  );
}

export function isSafeEntityId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function childPath(root: string, segment: string, label: string): string {
  if (!isSafePathSegment(segment)) {
    throw new Error(`Invalid ${label}.`);
  }
  const target = path.resolve(root, segment);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its data root.`);
  }
  return target;
}

export function appSrcDir(id: string): string {
  return path.resolve(APPS_DIR, id);
}

export function appRepoDir(id: string): string {
  return path.resolve(REPOS_DIR, `${id}.git`);
}

export function agentSessionDir(sessionId: string): string {
  return childPath(AGENTS_DIR, sessionId, 'Agent session id');
}

export function agentWorkDir(sessionId: string): string {
  return path.resolve(agentSessionDir(sessionId), 'work');
}

export function agentHomeDir(sessionId: string): string {
  return childPath(AGENT_HOME_DIR, sessionId, 'Agent session id');
}

export function agentAppWorkDir(sessionId: string, id: string): string {
  return path.resolve(agentWorkDir(sessionId), 'apps', id);
}

export function agentAttachmentWorkDir(
  sessionId: string,
  attachmentId: string,
): string {
  return path.resolve(agentWorkDir(sessionId), 'attachments', attachmentId);
}

export function agentAttachmentStoreDir(sessionId: string): string {
  return childPath(
    AGENT_ATTACHMENTS_DIR,
    sessionId,
    'Agent attachment session id',
  );
}

export function agentAttachmentStorePath(
  sessionId: string,
  attachmentId: string,
): string {
  return path.resolve(agentAttachmentStoreDir(sessionId), attachmentId);
}

export function agentWorkspaceIndexPath(sessionId: string): string {
  return path.resolve(agentSessionDir(sessionId), 'workspace-index.json');
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

/** Fixed persistent directory exposed to a storage-capable app backend. */
export function appStorageDir(id: string): string {
  return path.resolve(STORAGE_DIR, id);
}

/** ================== workflows ================== */
/**
 * Workflows mirror apps but live in their own namespaces so an app and a
 * workflow may share a slug without colliding on disk, including in Agent
 * workdirs (`apps/<id>` versus `workflows/<id>`).
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
/**
 * Legacy live-bundle mirror (workspace/workflow-current/<id>). Runs always
 * execute the immutable per-deployment artifact, so nothing writes here
 * anymore; kept only so deleteWorkflow can sweep dirs from older deploys.
 */
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

/** Agent worktree for a workflow, namespaced separately from apps. */
export function agentWorkflowWorkDir(sessionId: string, id: string): string {
  return path.resolve(agentWorkDir(sessionId), 'workflows', id);
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

/** Legacy live-bundle dir for a workflow (cleanup-only; see above). */
export function workflowCurrentDir(id: string): string {
  return path.resolve(WORKFLOW_CURRENT_DIR, id);
}
