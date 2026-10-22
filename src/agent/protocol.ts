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
import { createAppRequestSchema } from '~/platform-api/lifecycle-schemas';
export {
  createAppRequestSchema,
  createWorkflowRequestSchema,
  deploySourceRequestSchema,
  rollbackRequestSchema,
} from '~/platform-api/lifecycle-schemas';
import type { AgentStreamEvent } from './events';
import type { AgentAttachmentRef } from './attachments';
import { agentComposerContentSchema } from './composer-content';
import { isReservedEnvKey } from './env-keys';

export { DEFAULT_INTERNAL_PORT, RUNNER_WS_PATH } from './runner-constants';

export const PROTOCOL_VERSION = 18;

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

/** ================== shared payload schemas ================== */

export const askOptionSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
});

export const askQuestionSchema = z.strictObject({
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

export const envKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
  .refine((key) => !isReservedEnvKey(key), 'Environment key is reserved.');

export const envRequestIdSchema = z.string().min(1).max(128);
export const envDeliveryIdSchema = z.string().min(1).max(128);

export const envVariableFieldSchema = z.strictObject({
  key: envKeySchema,
  description: z.string().min(1).max(1_000),
  secret: z.boolean(),
});

function hasUniqueEnvKeys(fields: { key: string }[]): boolean {
  return new Set(fields.map((field) => field.key)).size === fields.length;
}

export const envRequestEventSchema = z
  .strictObject({
    type: z.literal('env_request'),
    requestId: envRequestIdSchema,
    reason: z.string().min(1).max(2_000),
    variables: z.array(envVariableFieldSchema).min(1).max(10),
  })
  .refine((event) => hasUniqueEnvKeys(event.variables), {
    message: 'Environment variable keys must be unique.',
    path: ['variables'],
  });

export const envStoredVariableSchema = z.strictObject({
  key: envKeySchema,
  secret: z.boolean(),
});

export const envStoredEventSchema = z
  .strictObject({
    type: z.literal('env_stored'),
    requestId: envRequestIdSchema,
    variables: z.array(envStoredVariableSchema).min(1).max(10),
  })
  .refine((event) => hasUniqueEnvKeys(event.variables), {
    message: 'Stored environment variable keys must be unique.',
    path: ['variables'],
  });

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

/** Every persisted/browser-visible event has an exact allowlisted shape. */
export const agentStreamEventSchema = z
  .union([
    z.strictObject({ type: z.literal('assistant_start') }),
    z.strictObject({ type: z.literal('text'), delta: z.string() }),
    z.strictObject({ type: z.literal('thinking'), delta: z.string() }),
    z.strictObject({
      type: z.literal('ask'),
      askId: z.string().min(1),
      questions: z.array(askQuestionSchema).min(1),
    }),
    z.strictObject({
      type: z.literal('ask_answered'),
      askId: z.string().min(1),
    }),
    envRequestEventSchema,
    envStoredEventSchema,
    z.strictObject({
      type: z.literal('tool_start'),
      id: z.string().min(1),
      name: z.string().min(1),
      label: z.string().optional(),
      args: z.json(),
      details: z.json().optional(),
    }),
    z.strictObject({
      type: z.literal('tool_update'),
      id: z.string().min(1),
      name: z.string().min(1),
      output: z.string(),
    }),
    z.strictObject({
      type: z.literal('tool_end'),
      id: z.string().min(1),
      name: z.string().min(1),
      isError: z.boolean(),
      output: z.string().optional(),
      details: z.json().optional(),
      summary: z.string().optional(),
    }),
    z.strictObject({ type: z.literal('turn_end') }),
    z.strictObject({ type: z.literal('cancelled') }),
    z.strictObject({ type: z.literal('done') }),
    z.strictObject({ type: z.literal('error'), message: z.string() }),
  ])
  .transform((value) => value as unknown as AgentStreamEvent);

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
    /** Legacy wire metadata; Runners always enable text and image input. */
    input: z.array(z.enum(['text', 'image'])),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
  }),
});
export type RunModelConfig = z.infer<typeof runModelConfigSchema>;

/** ================== runner -> platform messages ================== */

export const runnerHelloSchema = z.object({
  type: z.literal('runner.hello'),
  runnerId: z.string().min(1),
  protocolVersion: z.number().int(),
  /** Runs this runner is still executing (reclaim after reconnect). */
  activeRunIds: z.array(z.string()),
  /** Session directories currently persisted in this runner's data root. */
  workspaceSessionIds: z.array(z.string()),
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

export const runEnvResultSchema = z
  .strictObject({
    type: z.literal('run.env_result'),
    runId: z.string().min(1),
    requestId: envRequestIdSchema,
    deliveryId: envDeliveryIdSchema,
    ok: z.boolean(),
    errorCode: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/)
      .optional(),
  })
  .refine(
    (message) =>
      message.ok ? message.errorCode == null : message.errorCode != null,
    {
      message: 'errorCode is required exactly when ok is false.',
      path: ['errorCode'],
    },
  );
export type RunEnvResultMessage = z.infer<typeof runEnvResultSchema>;

export const runnerMessageSchema = z.discriminatedUnion('type', [
  runnerHelloSchema,
  runnerReadySchema,
  runnerPingSchema,
  runAcceptedSchema,
  runRejectedSchema,
  runEventMessageSchema,
  runFinishedMessageSchema,
  runEnvResultSchema,
]);
export type RunnerMessage = z.infer<typeof runnerMessageSchema>;

/** ================== platform -> runner messages ================== */

export const hubHelloAckSchema = z.object({
  type: z.literal('hub.hello_ack'),
  /** Platform-owned beta features applied before this Runner becomes ready. */
  betaFeatures: z.array(z.string().min(1)),
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
  composerContent: agentComposerContentSchema,
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
  userInitiated: z.boolean().optional(),
});

export const runAnswerSchema = z.object({
  type: z.literal('run.answer'),
  runId: z.string().min(1),
  askId: z.string().min(1),
  answers: z.array(askAnswerSchema),
});

const envValueEncoder = new TextEncoder();

function hasSafeDotenvEncoding(value: string): boolean {
  const first = value[0];
  return (
    !value.includes("'") ||
    !value.includes('`') ||
    (!value.includes('"') &&
      !value.includes('\\n') &&
      !value.includes('\\r')) ||
    (value.length > 0 &&
      !/[\s#]/u.test(value) &&
      (!["'", '"', '`'].includes(first) || value.at(-1) !== first))
  );
}

export const envEntrySchema = z.strictObject({
  key: envKeySchema,
  value: z.string().refine(
    (value) =>
      (
        value as string & {
          isWellFormed(): boolean;
        }
      ).isWellFormed() &&
      envValueEncoder.encode(value).byteLength <= 16 * 1024 &&
      !value.includes('\r') &&
      !value.includes('\n') &&
      !value.includes('\0') &&
      hasSafeDotenvEncoding(value),
    'Environment value is invalid.',
  ),
  secret: z.boolean(),
});
export type EnvEntry = z.infer<typeof envEntrySchema>;

export const envEntriesSchema = z
  .array(envEntrySchema)
  .min(1)
  .max(10)
  .refine((entries) => hasUniqueEnvKeys(entries), {
    message: 'Environment entry keys must be unique.',
  });

export const runEnvSchema = z.strictObject({
  type: z.literal('run.env'),
  runId: z.string().min(1),
  requestId: envRequestIdSchema,
  deliveryId: envDeliveryIdSchema,
  entries: envEntriesSchema,
});
export type RunEnvMessage = z.infer<typeof runEnvSchema>;

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

export const workspaceCleanupSchema = z.object({
  type: z.literal('workspace.cleanup'),
  scope: z.literal('session'),
  sessionId: z.string().min(1),
});

export const hubMessageSchema = z.union([
  hubHelloAckSchema,
  hubReadyAckSchema,
  hubPongSchema,
  runStartSchema,
  runCancelSchema,
  runAnswerSchema,
  runEnvSchema,
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

/** Runner-only create payload; session identity never comes from the model. */
export const createAppForSessionRequestSchema = createAppRequestSchema.extend({
  sessionId: z.string().min(1),
});

export {
  queryAppDbRequestSchema,
  queryAppKvCursorSchema,
  queryAppKvRequestSchema,
  QUERY_APP_DATA_TABLE_CURSOR_MAX_LENGTH,
  queryAppDataTableCursorSchema,
  queryAppDataTableRequestSchema,
} from '~/platform-api/data-schemas';
export type {
  QueryAppKvRequest,
  ParsedQueryAppKvRequest,
  QueryAppKvRecord,
  QueryAppKvResponse,
  QueryAppDataTableJsonValue,
  QueryAppDataTableRequest,
  ParsedQueryAppDataTableRequest,
  QueryAppDataTableSchema,
  QueryAppDataTableResponse,
} from '~/platform-api/data-schemas';

/** Response of GET .../source: the canonical repo master as a git bundle. */
export type SourceBundleResponse = {
  id: string;
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
