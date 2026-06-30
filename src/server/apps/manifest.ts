/**
 * App manifest schema + normalization.
 *
 * This module is intentionally dependency-light (only zod) so it can be imported
 * from both server infrastructure and client UI to share the normalized manifest
 * shape that drives iframe/widget loading.
 */
import { z } from 'zod';

/**
 * Reject manifest-provided paths that would escape the app source tree once
 * joined to it (absolute paths, Windows drive/UNC paths, or any `..` segment).
 * Kept as a pure string check so this module stays isomorphic (no `node:path`).
 */
function isUnsafeSourcePath(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('\\')) return true;
  if (/^[a-zA-Z]:/.test(p)) return true;
  return p.split(/[/\\]/).some((segment) => segment === '..');
}

/**
 * A relative path the build later joins against the app source dir to read or
 * bundle a file. Constrained so a malicious/mistaken manifest can't read files
 * outside the app source (e.g. `../../.env.local`).
 */
const sourceRelativePath = z
  .string()
  .min(1)
  .refine((p) => !isUnsafeSourcePath(p), {
    message:
      'must be a relative path inside the app source (no absolute or ".." paths)',
  });

/**
 * The backend entry must live under the `backend/` tree. The build only stages
 * `backend/` (plus generated `gen/`) into the runtime artifact, so an entry
 * elsewhere would deploy successfully yet fail to start at runtime. Enforcing it
 * here keeps the manifest honest about what the platform can actually run.
 */
const backendEntryPath = sourceRelativePath.refine(
  (p) => {
    const segments = p.split(/[/\\]/);
    return segments.length >= 2 && segments[0] === 'backend';
  },
  { message: 'backend entry must live under the "backend/" directory' },
);

/**
 * The proto entry must live under the fixed `proto/` tree. `buf.yaml` points the
 * module at `proto/`, the build only uploads `.proto` files from there, and the
 * generated `gen/` output is git-ignored — so a proto elsewhere would neither
 * compile nor be captured. Enforcing the path keeps the app's declared API
 * discoverable by the platform.
 */
const protoEntryPath = sourceRelativePath.refine(
  (p) => {
    const segments = p.split(/[/\\]/);
    return segments.length >= 2 && segments[0] === 'proto';
  },
  { message: 'proto entry must live under the "proto/" directory' },
);

export const widgetSizeSchema = z.object({
  w: z.number().int().min(1).max(12).default(4),
  h: z.number().int().min(1).max(12).default(3),
});

export const widgetSchema = z.object({
  // Used both as a URL path segment and as the built `<id>.js` filename, so it
  // must be a safe slug — never a value with path separators or `..`.
  id: z
    .string()
    .min(1)
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'widget id must contain only letters, digits, hyphens, or underscores',
    ),
  name: z.string().min(1),
  entry: sourceRelativePath,
  defaultSize: widgetSizeSchema.default({ w: 4, h: 3 }),
});

export const cronJobSchema = z
  .object({
    name: z.string().min(1),
    /** Standard 5-field cron expression: minute hour day-of-month month day-of-week. */
    schedule: z.string().min(1),
    /**
     * Preferred: the name of an RPC method on the app's declared service (e.g.
     * `RunCleanup`). On schedule the platform invokes that method through Connect
     * with an empty request and signs the call (HMAC) so the backend can trust
     * it came from the platform. The method must exist in the app's proto.
     */
    method: z.string().min(1).optional(),
    /**
     * Legacy: a raw backend path the platform POSTs to (e.g. "/__cron/cleanup").
     * Kept so apps authored before the RPC switch keep working; prefer `method`.
     */
    path: z.string().min(1).optional(),
  })
  .refine((j) => Boolean(j.method) !== Boolean(j.path), {
    message: 'each cron job must declare exactly one of "method" or "path"',
  });

export type CronJob = z.infer<typeof cronJobSchema>;

/**
 * A reference to a top-level Workflow this app's backend is allowed to invoke.
 * The app does NOT define the workflow — it is created independently in the
 * Workflow module; the platform injects the invocation URL + secret for each
 * declared workflow into the backend env at runtime so the app can trigger it
 * via the existing external workflow API.
 */
export const appWorkflowRefSchema = z.object({
  /**
   * Target workflow id (kebab-case slug, mirrors WORKFLOW_ID_RE in the workflow
   * module). Kept as an inline literal so this manifest stays isomorphic.
   */
  workflow: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, 'workflow must be a workflow id (kebab-case)'),
  /**
   * Optional stable key the app code uses to look the workflow up in the
   * injected `HATCH_WORKFLOWS` map. Defaults to the workflow id.
   */
  alias: z
    .string()
    .min(1)
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_-]*$/,
      'alias must start with a letter and contain only letters, digits, ' +
        'hyphens, or underscores',
    )
    .optional(),
});

export type AppWorkflowRef = z.infer<typeof appWorkflowRefSchema>;

/** Declared workflow calls with unique effective aliases (alias ?? workflow). */
const appWorkflowsSchema = z
  .array(appWorkflowRefSchema)
  .default([])
  .superRefine((refs, ctx) => {
    const seen = new Set<string>();
    for (const [i, ref] of refs.entries()) {
      const alias = ref.alias ?? ref.workflow;
      if (seen.has(alias)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate workflow alias "${alias}"`,
          path: [i, 'alias'],
        });
      }
      seen.add(alias);
    }
  });

/**
 * Inbound-webhook configuration. The webhook itself is always plain HTTP (any
 * verb/body — never Connect RPC); this only controls platform-side auth:
 *
 * - `platform` (default): the platform mints a per-app secret, verifies it on
 *   every call (`?secret=` or `x-hatch-secret`), strips it, and forwards the
 *   request to the backend's `/__webhook` with an HMAC signature
 *   (`x-hatch-timestamp` + `x-hatch-signature` over the body) so the app can
 *   trust the call was vetted by the platform. The secret never reaches the app.
 *   Best for simple notifications from your own services.
 * - `none`: no platform secret and no signature. The raw request is forwarded
 *   untouched; the app must authenticate it itself (e.g. verify a GitHub/Stripe
 *   signature). Best for integrating third-party webhook providers.
 */
export const webhookConfigSchema = z.object({
  auth: z.enum(['platform', 'none']).default('platform'),
});

export const capabilitiesSchema = z.object({
  database: z.boolean().default(false),
  frontend: z.boolean().default(false),
  widgets: z.boolean().default(false),
  backend: z.boolean().default(false),
  cron: z.boolean().default(false),
  webhook: z.boolean().default(false),
  storage: z.boolean().default(false),
  /** Simple per-app key/value store (platform DB) for small tokens/config. */
  kv: z.boolean().default(false),
});

/**
 * Canonical app-id shape: lowercase alphanumerics and hyphens, safe as a path
 * segment. A leading digit is allowed so generated ULID ids (e.g.
 * `01jabc...`) pass alongside legacy kebab-case ids (`habit-tracker`). This is
 * an internal, immutable identifier — see `APP_SLUG_RE` for the human URL slug.
 */
export const APP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Canonical app-slug shape: kebab-case, must start with a letter. Used in the
 * mutable, human-facing `/app/<slug>/` URL. Stricter than `APP_ID_RE` so slugs
 * stay readable and never collide with a bare numeric id.
 */
export const APP_SLUG_RE = /^[a-z][a-z0-9-]*$/;

/** True when `id` is a safe app-id path segment (ULID or legacy kebab). */
export function isValidAppId(id: string): boolean {
  return APP_ID_RE.test(id);
}

/** True when `slug` is a valid, human-facing app URL slug. */
export function isValidAppSlug(slug: string): boolean {
  return APP_SLUG_RE.test(slug);
}

export const sourceManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(
      APP_ID_RE,
      'id must be lowercase letters, digits, and hyphens (a ULID or kebab slug)',
    ),
  name: z.string().min(1),
  description: z.string().default(''),
  version: z.number().int().min(1).default(1),
  capabilities: capabilitiesSchema,
  backendMode: z.enum(['serverless', 'long-running']).default('serverless'),
  rpc: z
    .object({ proto: protoEntryPath, service: z.string().min(1) })
    .optional(),
  backend: z.object({ entry: backendEntryPath }).optional(),
  app: z
    .object({ entry: sourceRelativePath, html: sourceRelativePath.optional() })
    .optional(),
  widgets: z.array(widgetSchema).default([]),
  cron: z.array(cronJobSchema).default([]),
  /** Inbound webhook auth mode (see webhookConfigSchema); defaults to platform. */
  webhook: webhookConfigSchema.optional(),
  /** Top-level workflows this app's backend may invoke (see appWorkflowRefSchema). */
  workflows: appWorkflowsSchema,
});

export type SourceManifest = z.infer<typeof sourceManifestSchema>;
export type AppCapabilitiesShape = z.infer<typeof capabilitiesSchema>;
/** Platform-side inbound-webhook auth mode (see webhookConfigSchema). */
export type WebhookAuth = z.infer<typeof webhookConfigSchema>['auth'];

export type NormalizedWidget = {
  id: string;
  name: string;
  /** ESM module URL exposing `mount(element, props)`. */
  url: string;
  defaultSize: { w: number; h: number };
};

/** A single RPC method parsed from the app's compiled proto descriptor. */
export type RpcMethodApi = {
  name: string;
  /** Fully-qualified input message type (leading dot stripped). */
  inputType: string;
  /** Fully-qualified output message type (leading dot stripped). */
  outputType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
};

/** A service (and its methods) defined in the app's proto. */
export type RpcServiceApi = {
  /** Fully-qualified service name, e.g. `app.v1.CounterService`. */
  name: string;
  methods: RpcMethodApi[];
};

/** A raw proto source file uploaded to the platform on deploy. */
export type ProtoFile = {
  /** Source-relative path, e.g. `proto/service.proto`. */
  path: string;
  content: string;
};

/**
 * The app's declared API, captured at deploy time from its proto: every service
 * + method (so the platform knows what the app exposes) and the raw proto
 * sources (uploaded for reference / future regeneration). Populated by the build
 * after `buf generate`; absent for apps without an RPC service.
 */
export type AppApi = {
  services: RpcServiceApi[];
  protoFiles: ProtoFile[];
};

/**
 * A resolved outbound workflow call this app declares. The invocation URL +
 * secret are NOT stored here (they are injected into the backend env at runtime,
 * never shipped to the browser) — only the alias the app code uses and the
 * target workflow id.
 */
export type NormalizedAppWorkflow = {
  /** Key the app uses in the injected `HATCH_WORKFLOWS` map. */
  alias: string;
  /** Target workflow id. */
  workflow: string;
};

export type NormalizedManifest = {
  id: string;
  name: string;
  description: string;
  version: number;
  capabilities: AppCapabilitiesShape;
  backendMode: 'serverless' | 'long-running';
  /** Source-relative backend entry the platform runs, when a backend is present. */
  backend?: { entry: string };
  /** Iframe URL for the full app, when a frontend is present. */
  app?: { url: string };
  widgets: NormalizedWidget[];
  /** Connect RPC base URL + fully-qualified service name, when a backend is present. */
  rpc?: { url: string; service: string };
  /** Scheduled jobs the platform triggers against the backend. */
  cron: CronJob[];
  /**
   * Top-level workflows this app's backend may invoke. Present only when the
   * app has a backend and declares workflow calls. The runtime injects the
   * matching URL + secret per alias into the backend env (`HATCH_WORKFLOWS`).
   */
  workflows?: NormalizedAppWorkflow[];
  /**
   * Inbound webhook URL + platform-side auth mode, when the webhook capability
   * is enabled. `platform` = secret-verified + HMAC-signed forward; `none` =
   * unauthenticated passthrough (app self-secures). See webhookConfigSchema.
   */
  webhook?: { url: string; auth: WebhookAuth };
  /** Blob storage base URL, when the storage capability is enabled. */
  storage?: { url: string };
  /** KV REST base URL, when the kv capability is enabled. */
  kv?: { url: string };
  /**
   * The app's declared RPC API, captured from its proto at build time. Absent
   * for apps without an RPC service. Lets the platform (and the manage UI) know
   * exactly which services + methods an app exposes.
   */
  api?: AppApi;
};

/** Root path the platform serves an app's runtime assets + RPC under. */
export function appBasePath(id: string): string {
  return `/api/apps/${id}`;
}

export function appUrl(id: string): string {
  return `/app/${id}/`;
}

export function widgetUrl(id: string, widgetId: string): string {
  return `${appBasePath(id)}/widget/${widgetId}`;
}

export function rpcUrl(id: string): string {
  return `${appBasePath(id)}/rpc`;
}

export function storageUrl(id: string): string {
  return `${appBasePath(id)}/storage`;
}

/** Per-app KV REST base. The backend calls it with an HMAC signature. */
export function kvUrl(id: string): string {
  return `${appBasePath(id)}/kv`;
}

/** Public inbound webhook URL (token appended at call time as `?secret=`). */
export function webhookUrl(id: string): string {
  return `/api/hooks/${id}`;
}

/** Parse + validate raw manifest JSON authored by the Agent. */
export function parseSourceManifest(raw: unknown): SourceManifest {
  return sourceManifestSchema.parse(raw);
}

/** Produce the deploy-time manifest with concrete platform URLs. */
export function normalizeManifest(src: SourceManifest): NormalizedManifest {
  const out: NormalizedManifest = {
    id: src.id,
    name: src.name,
    description: src.description,
    version: src.version,
    capabilities: src.capabilities,
    backendMode: src.backendMode,
    widgets: src.capabilities.widgets
      ? src.widgets.map((w) => ({
          id: w.id,
          name: w.name,
          url: widgetUrl(src.id, w.id),
          defaultSize: w.defaultSize,
        }))
      : [],
    cron: src.capabilities.cron ? src.cron : [],
  };
  if (src.capabilities.backend && src.backend) {
    out.backend = { entry: src.backend.entry };
  }
  if (src.capabilities.frontend && src.app) {
    out.app = { url: appUrl(src.id) };
  }
  if (src.capabilities.backend && src.rpc) {
    out.rpc = { url: rpcUrl(src.id), service: src.rpc.service };
  }
  if (src.capabilities.webhook) {
    out.webhook = {
      url: webhookUrl(src.id),
      auth: src.webhook?.auth ?? 'platform',
    };
  }
  if (src.capabilities.storage) {
    out.storage = { url: storageUrl(src.id) };
  }
  // KV is reachable only from the app's own backend over the HMAC-signed route
  // (a signing secret is minted only for backend apps), so like rpc / workflow
  // calls it's meaningful only when a backend is actually staged. Without this
  // gate a backendless app would advertise a KV URL that always 404s.
  if (src.capabilities.kv && src.capabilities.backend && src.backend) {
    out.kv = { url: kvUrl(src.id) };
  }
  // Workflow calls are outbound from the backend (the platform injects each
  // target's secret into the backend env), so they only apply to apps that
  // actually stage a backend — the capability alone, without a `backend.entry`,
  // produces no process to receive the injected config.
  if (src.capabilities.backend && src.backend && src.workflows.length > 0) {
    out.workflows = src.workflows.map((w) => ({
      alias: w.alias ?? w.workflow,
      workflow: w.workflow,
    }));
  }
  return out;
}
