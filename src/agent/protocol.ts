/**
 * Wire protocol between the Platform (control plane) and the Agent Runner
 * (execution plane). The Runner is the only side that opens connections:
 * a WebSocket control channel for run dispatch/events plus REST calls for
 * app/workflow operations. Both sides validate every message against these
 * schemas.
 *
 * This module must stay dependency-free of `~server/*` and `~/db` (types
 * excepted) so the Runner bundle never pulls in platform-only code.
 */
import { z } from 'zod';
import type { AgentStreamEvent } from './events';
import type { AgentAttachmentRef } from './attachments';

export const PROTOCOL_VERSION = 4;

/** How long a run lease stays valid without renewal (heartbeat/events renew). */
export const RUN_LEASE_TTL_MS = 90_000;
/** Runner heartbeat interval; must be well under {@link RUN_LEASE_TTL_MS}. */
export const RUNNER_HEARTBEAT_MS = 15_000;
/** Platform sweep interval for expiring stale run leases. */
export const LEASE_SWEEP_INTERVAL_MS = 30_000;
/** How long the platform waits for a runner to accept a dispatched run. */
export const DISPATCH_ACCEPT_TIMEOUT_MS = 10_000;
/**
 * How long a disconnected runner keeps executing before aborting its runs.
 * Slightly above the lease TTL: the platform will have interrupted the runs
 * first, so the runner is only cleaning up work nobody can observe anymore.
 */
export const RUNNER_OFFLINE_ABORT_MS = 120_000;

/** Default internal port the platform's runner-facing server listens on. */
export const DEFAULT_INTERNAL_PORT = 3701;
/** WebSocket path on the internal server. */
export const RUNNER_WS_PATH = '/internal/agent/runner/ws';

/** ================== shared payload schemas ================== */

export const askOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
});

export const askQuestionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  options: z.array(askOptionSchema),
  allowMultiple: z.boolean(),
});

export const askAnswerSchema = z.object({
  questionId: z.string().min(1),
  selectedOptionIds: z.array(z.string()).default([]),
  customText: z.string().optional(),
});
export type AskAnswerPayload = z.infer<typeof askAnswerSchema>;

export const sendImageSchema = z.object({
  data: z.string().min(1),
  mimeType: z.string().min(1),
});
export type SendImage = z.infer<typeof sendImageSchema>;

export const agentAttachmentRefSchema: z.ZodType<AgentAttachmentRef> = z.object(
  {
    id: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative(),
  },
);

/**
 * Stream events are produced and consumed by our own code on both ends; the
 * envelope only shape-checks the discriminator and passes the payload through.
 */
export const agentStreamEventSchema = z
  .looseObject({ type: z.string().min(1) })
  .transform((v) => v as unknown as AgentStreamEvent);

/** ================== run model config ================== */

/**
 * Everything the Runner needs to call the model for one run. Resolved by the
 * platform from the provider tables; the Runner never reads the database. The
 * API key is scoped to the picked provider — there is no "list all secrets"
 * surface.
 */
export const runModelConfigSchema = z.object({
  providerId: z.string().min(1),
  providerName: z.string().min(1),
  apiType: z.enum([
    'openai-responses',
    'openai-completions',
    'anthropic-messages',
  ]),
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  model: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    reasoning: z.boolean(),
    input: z.array(z.enum(['text', 'image'])),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
  }),
});
export type RunModelConfig = z.infer<typeof runModelConfigSchema>;

/** ================== runner -> platform messages ================== */

export const workspaceSourceClaimSchema = z.object({
  sessionId: z.string().min(1),
  kind: z.enum(['app', 'workflow']),
  id: z.string().min(1),
  /** Entity creation token; null only for an unindexed compatibility path. */
  generation: z.string().min(1).nullable(),
});
export type WorkspaceSourceClaim = z.infer<typeof workspaceSourceClaimSchema>;

export const runnerHelloSchema = z.object({
  type: z.literal('runner.hello'),
  runnerId: z.string().min(1),
  protocolVersion: z.number().int(),
  /** Runs this runner is still executing (reclaim after reconnect). */
  activeRunIds: z.array(z.string()),
  /** Session directories currently persisted in this runner's data root. */
  workspaceSessionIds: z.array(z.string()),
  /** Source workspaces present when this hello snapshot was captured. */
  workspaceSources: z.array(workspaceSourceClaimSchema),
});

export const runnerReadySchema = z.object({
  type: z.literal('runner.ready'),
});

export const runnerPingSchema = z.object({
  type: z.literal('runner.ping'),
});

export const runAcceptedSchema = z.object({
  type: z.literal('run.accepted'),
  runId: z.string().min(1),
});

export const runRejectedSchema = z.object({
  type: z.literal('run.rejected'),
  runId: z.string().min(1),
  reason: z.string(),
});

/**
 * One stream event. `runnerSeq` is a per-run monotonic counter assigned by the
 * runner; the platform dedupes on (runId, runnerSeq) so resends after a
 * reconnect are safe.
 */
export const runEventMessageSchema = z.object({
  type: z.literal('run.event'),
  runId: z.string().min(1),
  runnerSeq: z.number().int().positive(),
  event: agentStreamEventSchema,
});

export const runFinishedMessageSchema = z.object({
  type: z.literal('run.finished'),
  runId: z.string().min(1),
  status: z.enum(['completed', 'failed', 'cancelled']),
  error: z.string().optional(),
  /** Full transcript (pi AgentMessage[]) persisted onto the session. */
  messages: z.array(z.unknown()),
});

export const runnerMessageSchema = z.discriminatedUnion('type', [
  runnerHelloSchema,
  runnerReadySchema,
  runnerPingSchema,
  runAcceptedSchema,
  runRejectedSchema,
  runEventMessageSchema,
  runFinishedMessageSchema,
]);
export type RunnerMessage = z.infer<typeof runnerMessageSchema>;

/** ================== platform -> runner messages ================== */

export const hubHelloAckSchema = z.object({
  type: z.literal('hub.hello_ack'),
  /**
   * Runs this runner should keep reporting on: still-owned active runs (keep
   * executing + resend queues) and owned runs already terminal on the
   * platform whose unacked final report should be resent, not discarded.
   */
  resumedRunIds: z.array(z.string()),
  /** Runs this runner no longer owns (reassigned/unknown); abort + discard. */
  staleRunIds: z.array(z.string()),
  /** Local session roots whose Platform sessions were deleted while offline. */
  staleWorkspaceSessionIds: z.array(z.string()),
  /** Hello-time source claims whose entity/generation is no longer current. */
  staleWorkspaceSources: z.array(workspaceSourceClaimSchema),
});

export const hubReadyAckSchema = z.object({
  type: z.literal('hub.ready_ack'),
});

export const hubPongSchema = z.object({
  type: z.literal('hub.pong'),
});

export const runStartSchema = z.object({
  type: z.literal('run.start'),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  userText: z.string(),
  images: z.array(sendImageSchema),
  attachments: z.array(agentAttachmentRefSchema),
  /** Persisted pi AgentMessage[] history for the session. */
  priorMessages: z.array(z.unknown()),
  model: runModelConfigSchema,
});
export type RunStartPayload = Omit<z.infer<typeof runStartSchema>, 'type'>;

export const runCancelSchema = z.object({
  type: z.literal('run.cancel'),
  runId: z.string().min(1),
});

export const runAnswerSchema = z.object({
  type: z.literal('run.answer'),
  runId: z.string().min(1),
  askId: z.string().min(1),
  answers: z.array(askAnswerSchema),
});

/** Cumulative ack: the runner may drop buffered events up to `runnerSeq`. */
export const runEventAckSchema = z.object({
  type: z.literal('run.event_ack'),
  runId: z.string().min(1),
  runnerSeq: z.number().int().positive(),
});

export const runFinishAckSchema = z.object({
  type: z.literal('run.finish_ack'),
  runId: z.string().min(1),
});

export const workspaceCleanupSchema = z.discriminatedUnion('scope', [
  z.object({
    type: z.literal('workspace.cleanup'),
    scope: z.literal('session'),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal('workspace.cleanup'),
    scope: z.literal('app'),
    id: z.string().min(1),
    generation: z.string().min(1),
  }),
  z.object({
    type: z.literal('workspace.cleanup'),
    scope: z.literal('workflow'),
    id: z.string().min(1),
    generation: z.string().min(1),
  }),
]);

export const hubMessageSchema = z.union([
  hubHelloAckSchema,
  hubReadyAckSchema,
  hubPongSchema,
  runStartSchema,
  runCancelSchema,
  runAnswerSchema,
  runEventAckSchema,
  runFinishAckSchema,
  workspaceCleanupSchema,
]);
export type HubMessage = z.infer<typeof hubMessageSchema>;

/** ================== scaffold file transfer ================== */

/**
 * Reject anything that could escape the target directory when joined: absolute
 * paths, `..`/`.` segments, backslashes, and empty segments. Paths are always
 * exchanged with `/` separators.
 */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) {
    return false;
  }
  return p
    .split('/')
    .every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

export const scaffoldFileSchema = z.object({
  path: z.string().refine(isSafeRelativePath, {
    message: 'Unsafe scaffold file path.',
  }),
  /** File contents, base64-encoded (uniform for text and binary). */
  contentBase64: z.string(),
});
export type ScaffoldFile = z.infer<typeof scaffoldFileSchema>;

/** ================== internal REST payloads ================== */

export const createAppRequestSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  pin: z.boolean().optional(),
});

export const createWorkflowRequestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  pin: z.boolean().optional(),
});

export const deploySourceRequestSchema = z.object({
  message: z.string().min(1),
  /** Entity creation token observed before the runner bundled the worktree. */
  generation: z.string().min(1),
  /** Git bundle of the worktree HEAD, base64-encoded. */
  bundleBase64: z.string().min(1),
});

export const rollbackRequestSchema = z.object({
  version: z.number().int().positive(),
});

export const queryAppDbRequestSchema = z.object({
  sql: z.string().min(1),
});

const queryAppKvListRequestSchema = z
  .object({
    action: z.literal('list'),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).default(100),
    revealSecrets: z.boolean().default(false),
  })
  .strict();

const queryAppKvGetRequestSchema = z
  .object({
    action: z.literal('get'),
    key: z.string(),
    revealSecrets: z.boolean().default(false),
  })
  .strict();

const queryAppKvSetRequestSchema = z
  .object({
    action: z.literal('set'),
    key: z.string(),
    value: z.string(),
    secret: z.boolean().optional(),
  })
  .strict();

const queryAppKvDeleteRequestSchema = z
  .object({
    action: z.literal('delete'),
    key: z.string(),
  })
  .strict();

export const queryAppKvRequestSchema = z.discriminatedUnion('action', [
  queryAppKvListRequestSchema,
  queryAppKvGetRequestSchema,
  queryAppKvSetRequestSchema,
  queryAppKvDeleteRequestSchema,
]);
/** Request accepted from the runner; list limit is optional before parsing. */
export type QueryAppKvRequest = z.input<typeof queryAppKvRequestSchema>;
/** Strictly parsed request used by the platform implementation. */
export type ParsedQueryAppKvRequest = z.output<typeof queryAppKvRequestSchema>;

export type QueryAppKvRecord = {
  key: string;
  value: string | null;
  secret: boolean;
  createdAt: string;
  updatedAt: string;
};

export type QueryAppKvResponse =
  | {
      action: 'list';
      items: QueryAppKvRecord[];
      nextCursor: string | null;
    }
  | { action: 'get'; record: QueryAppKvRecord | null }
  | { action: 'set'; record: QueryAppKvRecord }
  | { action: 'delete'; ok: boolean };

/** Response of GET .../source: the canonical repo master as a git bundle. */
export type SourceBundleResponse = {
  id: string;
  /** Immutable creation token for this incarnation of the entity. */
  generation: string;
  masterCommit: string | null;
  /** Null when the repo has no commits yet (nothing to bundle). */
  bundleBase64: string | null;
};

export function parseRunnerMessage(raw: unknown): RunnerMessage {
  return runnerMessageSchema.parse(raw);
}

export function parseHubMessage(raw: unknown): HubMessage {
  return hubMessageSchema.parse(raw);
}
