/**
 * The Agent Runner's view of the platform: every app/workflow operation a tool
 * can perform goes through this interface instead of importing `~server/*`.
 * The runner implements it with authenticated REST calls to the platform's
 * internal API; tests can stub it.
 *
 * Only `import type` from server modules here — the runner bundle must never
 * pull in platform code (database client, deploy pipeline, …).
 */
import type { NormalizedManifest } from '~server/apps/manifest';
import type { AppDetail, AppSummary } from '~server/apps/inspect';
import type { NormalizedWorkflowManifest } from '~server/workflows/manifest';
import type {
  WorkflowDetailForAgent,
  WorkflowSummaryForAgent,
} from '~server/workflows/inspect';
import type { ScaffoldFile, SourceBundleResponse } from './protocol';

export type CreateAppResult = {
  id: string;
  generation: string;
  slug: string;
  name: string;
  /** Rendered scaffold template for the runner to write into its worktree. */
  files: ScaffoldFile[];
};

export type CreateWorkflowResult = {
  id: string;
  generation: string;
  name: string;
  files: ScaffoldFile[];
};

export type AppDeployResponse = {
  deploymentId: string;
  version: number;
  slug: string;
  normalized: NormalizedManifest;
};

export type WorkflowDeployResponse = {
  deploymentId: string;
  version: number;
  normalized: NormalizedWorkflowManifest;
};

export type QueryAppDbResponse = {
  /** Rendered result (JSON rows or an OK summary), already size-capped. */
  text: string;
  rowCount: number;
};

export type DownloadedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  body: Uint8Array;
};

export type PlatformClient = {
  downloadAttachment(
    sessionId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<DownloadedAttachment>;

  listApps(): Promise<AppSummary[]>;
  /** Resolves an id-or-slug handle; null when no app matches. */
  getApp(handle: string): Promise<AppDetail | null>;
  createApp(input: {
    slug: string;
    name: string;
    description?: string;
    pin?: boolean;
  }): Promise<CreateAppResult>;
  /** Canonical repo master as a git bundle (null bundle when empty). */
  getAppSource(handle: string): Promise<SourceBundleResponse>;
  deployApp(
    id: string,
    opts: { message: string; generation: string; bundleBase64: string },
  ): Promise<AppDeployResponse>;
  rollbackApp(handle: string, version: number): Promise<{ version: number }>;
  /** `signal` aborts the platform request (and the running statement). */
  queryAppDb(
    handle: string,
    sql: string,
    signal?: AbortSignal,
  ): Promise<QueryAppDbResponse>;

  listWorkflows(): Promise<WorkflowSummaryForAgent[]>;
  getWorkflow(id: string): Promise<WorkflowDetailForAgent | null>;
  createWorkflow(input: {
    id: string;
    name: string;
    description?: string;
    pin?: boolean;
  }): Promise<CreateWorkflowResult>;
  getWorkflowSource(id: string): Promise<SourceBundleResponse>;
  deployWorkflow(
    id: string,
    opts: { message: string; generation: string; bundleBase64: string },
  ): Promise<WorkflowDeployResponse>;
  rollbackWorkflow(id: string, version: number): Promise<{ version: number }>;
};
