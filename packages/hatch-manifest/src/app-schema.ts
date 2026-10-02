/**
 * App manifest schema + normalization.
 *
 * This module is intentionally dependency-light (only zod) so it can be imported
 * from both server infrastructure and client UI to share the normalized manifest
 * shape that drives iframe/widget loading.
 */
import { z } from 'zod';
import { isAppManagedPathSegment } from './app-managed-path.js';
import {
  APP_NAME_MAX_LENGTH,
  APP_SLUG_MAX_LENGTH,
  isAppNameWithinMaxLength,
} from './app-identity.js';
import { networkPolicySchema } from './network-policy.js';

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
  })
  .refine((p) => !p.split(/[/\\]/).some(isAppManagedPathSegment), {
    message: 'must not point into the platform-owned ".hatch/" directory',
  });

/**
 * The backend entry must live under the fixed `backend/` source tree. The build
 * uses that tree as the boundary for backend code and emits its runtime entry
 * below the matching artifact directory.
 */
const backendEntryPath = sourceRelativePath
  .refine(
    (p) => {
      const segments = p.split(/[/\\]/);
      return segments.length >= 2 && segments[0] === 'backend';
    },
    { message: 'backend entry must live under the "backend/" directory' },
  )
  .refine(
    (p) => {
      const segments = p
        .split(/[/\\]/)
        .filter((segment) => segment !== '' && segment !== '.');
      return segments[1] !== 'assets';
    },
    {
      message:
        'backend entry must not live under the reserved "backend/assets/" directory',
    },
  );

/**
 * The proto entry must live under the fixed `proto/` tree. `buf.yaml` points the
 * module at `proto/`, the build only uploads `.proto` files from there, and the
 * generated `gen/` output is git-ignored — so a proto elsewhere would neither
 * compile nor be captured. Enforcing the path keeps the app's declared API
 * discoverable by the platform.
 */
const protoEntryPath = sourceRelativePath
  .refine(
    (p) => {
      const segments = p.split(/[/\\]/);
      return segments.length >= 2 && segments[0] === 'proto';
    },
    { message: 'proto entry must live under the "proto/" directory' },
  )
  .refine((p) => p.endsWith('.proto'), {
    message: 'proto entry must name a .proto file',
  });

/** Keep user-facing route metadata on one line. */
const hasNoLineBreak = (s: string): boolean => !/[\r\n]/.test(s);

const singleLineNonEmpty = z
  .string()
  .min(1)
  .refine(hasNoLineBreak, { message: 'must not contain line breaks' });

/** A user-facing route the app exposes through its hash router. */
export const appRouteSchema = z.object({
  path: singleLineNonEmpty.refine((path) => path.startsWith('/'), {
    message: 'route path must start with "/"',
  }),
  description: singleLineNonEmpty.refine(
    (description) => description.trim().length > 0,
    { message: 'route description must not be blank' },
  ),
});

export type AppRoute = z.infer<typeof appRouteSchema>;

const appRoutesSchema = z
  .array(appRouteSchema)
  .default([])
  .superRefine((routes, ctx) => {
    const seen = new Set<string>();
    for (const [index, route] of routes.entries()) {
      if (seen.has(route.path)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate app route path "${route.path}"`,
          path: [index, 'path'],
        });
      }
      seen.add(route.path);
    }
  });

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
  /**
   * The discrete grid footprints the widget supports. When non-empty the
   * dashboard constrains resizing to these sizes (snapping to the nearest on
   * release) instead of allowing any free-form span. Leave empty for a widget
   * that adapts to any size.
   */
  supportedSizes: z.array(widgetSizeSchema).default([]),
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
   * Target Workflow id (generated ULID or legacy kebab id). Kept as an inline
   * literal so this manifest stays isomorphic.
   */
  workflow: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      'workflow must be a Workflow id (ULID or legacy kebab id)',
    ),
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

const supportedCapabilitiesSchema = z.object({
  database: z.boolean().default(false),
  frontend: z.boolean().default(false),
  widgets: z.boolean().default(false),
  backend: z.boolean().default(false),
  cron: z.boolean().default(false),
  webhook: z.boolean().default(false),
  /** Private persistent directory exposed only to the app backend. */
  storage: z.boolean().default(false),
  /** Simple per-app key/value store (platform DB) for small tokens/config. */
  kv: z.boolean().default(false),
  /** Platform-managed typed tables with migrations and realtime queries. */
  dataTable: z.boolean().default(false),
});

export const capabilitiesSchema = supportedCapabilitiesSchema
  .extend({
    /** Removed; retained only so legacy manifests remain parseable. */
    userscripts: z.unknown().optional(),
  })
  .strict()
  .transform((capabilities) => supportedCapabilitiesSchema.parse(capabilities));

/**
 * Canonical app-id shape: lowercase alphanumerics and hyphens, safe as a path
 * segment. A leading digit is allowed so generated ULID ids (e.g.
 * `01jabc...`) pass alongside legacy kebab-case ids (`habit-tracker`). This is
 * an internal, immutable identifier — see `APP_SLUG_RE` for the human URL slug.
 */
export const APP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Canonical app-slug shape: kebab-case, must start with a letter. Used in the
 * mutable, human-facing `/app/<slug>` URL. Stricter than `APP_ID_RE` so slugs
 * stay readable and never collide with a bare numeric id.
 */
export const APP_SLUG_RE = /^[a-z][a-z0-9-]*$/;

/** True when `id` is a safe app-id path segment (ULID or legacy kebab). */
export function isValidAppId(id: string): boolean {
  return APP_ID_RE.test(id);
}

/** True when `slug` is a valid, human-facing app URL slug. */
export function isValidAppSlug(slug: string): boolean {
  return slug.length <= APP_SLUG_MAX_LENGTH && APP_SLUG_RE.test(slug);
}

export const sourceManifestSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(
        APP_ID_RE,
        'id must be lowercase letters, digits, and hyphens (a ULID or kebab slug)',
      ),
    name: z
      .string()
      .min(1)
      .refine(isAppNameWithinMaxLength, {
        message: `name must be at most ${APP_NAME_MAX_LENGTH} characters`,
      }),
    description: z.string().default(''),
    /** Removed; retained only so legacy manifests remain parseable. */
    version: z.unknown().optional(),
    compatibilityVersion: z.number().int().min(1).optional(),
    capabilities: capabilitiesSchema,
    backendMode: z.enum(['serverless', 'long-running']).default('serverless'),
    rpc: z
      .object({ proto: protoEntryPath, service: z.string().min(1) })
      .optional(),
    backend: z
      .object({
        entry: backendEntryPath,
        /** Unified Deno network permission for the deployed backend. */
        network: networkPolicySchema.optional(),
      })
      .strict()
      .optional(),
    app: z
      .object({
        entry: sourceRelativePath,
        html: sourceRelativePath.optional(),
        /** Discoverability metadata only; the platform does not register routes. */
        routes: appRoutesSchema,
      })
      .optional(),
    widgets: z.array(widgetSchema).default([]),
    /** Removed; retained only so legacy manifests remain parseable. */
    userscripts: z.unknown().optional(),
    cron: z.array(cronJobSchema).default([]),
    /** Inbound webhook auth mode (see webhookConfigSchema); defaults to platform. */
    webhook: webhookConfigSchema.optional(),
    /** Top-level workflows this app's backend may invoke (see appWorkflowRefSchema). */
    workflows: appWorkflowsSchema,
  })
  .superRefine((manifest, ctx) => {
    if (
      manifest.capabilities.storage &&
      (!manifest.capabilities.backend || !manifest.backend)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'capabilities.storage requires capabilities.backend and backend.entry',
        path: ['capabilities', 'storage'],
      });
    }

    if (manifest.capabilities.frontend && !manifest.app) {
      ctx.addIssue({
        code: 'custom',
        message: 'capabilities.frontend is true but app.entry is not declared',
        path: ['app'],
      });
    }
    if (manifest.capabilities.backend && !manifest.backend) {
      ctx.addIssue({
        code: 'custom',
        message:
          'capabilities.backend is true but backend.entry is not declared',
        path: ['backend'],
      });
    }
    if (manifest.rpc && (!manifest.capabilities.backend || !manifest.backend)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'rpc requires capabilities.backend to be true and backend.entry to be declared',
        path: ['rpc'],
      });
    }
    if (manifest.capabilities.widgets && manifest.widgets.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'capabilities.widgets is true but no widgets are declared',
        path: ['widgets'],
      });
    }
  });

export type SourceManifest = z.infer<typeof sourceManifestSchema>;
export type AppCapabilitiesShape = z.infer<typeof capabilitiesSchema>;
/** Platform-side inbound-webhook auth mode (see webhookConfigSchema). */
export type WebhookAuth = z.infer<typeof webhookConfigSchema>['auth'];
