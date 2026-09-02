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
import type { AppCompatibility } from '~/app-compatibility';
import type { WorkflowCompatibility } from '~/workflow-compatibility';
import type { AppDetail, AppSummary } from '~server/apps/inspect';
import type { NormalizedWorkflowManifest } from '~server/workflows/manifest';
import type {
  WorkflowDetailForAgent,
  WorkflowSummaryForAgent,
} from '~server/workflows/inspect';
import type {
  QueryAppDataTableRequest,
  QueryAppDataTableResponse,
  QueryAppKvRequest,
  QueryAppKvResponse,
  ScaffoldFile,
  SourceBundleResponse,
} from './protocol';

export type CreateAppResult = {
  id: string;
  slug: string;
  name: string;
  /** Rendered scaffold template for the runner to write into its worktree. */
  files: ScaffoldFile[];
};

export type CreateWorkflowResult = {
  id: string;
  slug: string;
  name: string;
  files: ScaffoldFile[];
};

export type AppDeployResponse = {
  deploymentId: string;
  version: number;
  compatibilityVersion: number;
  slug: string;
  normalized: NormalizedManifest;
};

export type WorkflowDeployResponse = {
  deploymentId: string;
  version: number;
  compatibilityVersion: number;
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
  /** Looks up an App by its immutable id; null when no App matches. */
  getApp(appId: string): Promise<AppDetail | null>;
  /** Idempotently associate a conversation with one canonical App. */
  associateSessionApp(
    sessionId: string,
    appId: string,
  ): Promise<{ appId: string }>;
  createApp(
    input: {
      slug: string;
      name: string;
      description?: string;
      pin?: boolean;
    },
    sessionId: string,
  ): Promise<CreateAppResult>;
  /** Canonical repo master as a git bundle (null bundle when empty). */
  getAppSource(appId: string): Promise<SourceBundleResponse>;
  deployApp(
    appId: string,
    opts: {
      message: string;
      generation: string;
      bundleBase64: string;
      allowDestructiveDataMigration?: boolean;
      dataMigrationApprovalToken?: string;
    },
  ): Promise<AppDeployResponse>;
  rollbackApp(
    appId: string,
    version: number,
  ): Promise<{
    version: number;
    dataSchemaMismatch: boolean;
    compatibility: AppCompatibility;
  }>;
  /** `signal` aborts the platform request (and the running statement). */
  queryAppDb(
    appId: string,
    sql: string,
    signal?: AbortSignal,
  ): Promise<QueryAppDbResponse>;
  queryAppKv(
    appId: string,
    input: QueryAppKvRequest,
    signal?: AbortSignal,
  ): Promise<QueryAppKvResponse>;
  queryAppDataTable(
    appId: string,
    input: QueryAppDataTableRequest,
    signal?: AbortSignal,
  ): Promise<QueryAppDataTableResponse>;

  listWorkflows(): Promise<WorkflowSummaryForAgent[]>;
  /** Looks up a Workflow by its immutable id; null when no Workflow matches. */
  getWorkflow(workflowId: string): Promise<WorkflowDetailForAgent | null>;
  createWorkflow(input: {
    slug: string;
    name: string;
    description?: string;
    pin?: boolean;
  }): Promise<CreateWorkflowResult>;
  getWorkflowSource(workflowId: string): Promise<SourceBundleResponse>;
  deployWorkflow(
    workflowId: string,
    opts: { message: string; generation: string; bundleBase64: string },
  ): Promise<WorkflowDeployResponse>;
  rollbackWorkflow(
    workflowId: string,
    version: number,
  ): Promise<{ version: number; compatibility: WorkflowCompatibility }>;
};
