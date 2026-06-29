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

export const cronJobSchema = z.object({
  name: z.string().min(1),
  /** Standard 5-field cron expression: minute hour day-of-month month day-of-week. */
  schedule: z.string().min(1),
  /** Backend path the platform POSTs to on schedule (e.g. "/__cron/cleanup"). */
  path: z.string().min(1),
});

export type CronJob = z.infer<typeof cronJobSchema>;

export const capabilitiesSchema = z.object({
  database: z.boolean().default(false),
  frontend: z.boolean().default(false),
  widgets: z.boolean().default(false),
  backend: z.boolean().default(false),
  cron: z.boolean().default(false),
  webhook: z.boolean().default(false),
  storage: z.boolean().default(false),
  workflow: z.boolean().default(false),
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
    .object({ proto: sourceRelativePath, service: z.string().min(1) })
    .optional(),
  backend: z.object({ entry: backendEntryPath }).optional(),
  app: z
    .object({ entry: sourceRelativePath, html: sourceRelativePath.optional() })
    .optional(),
  widgets: z.array(widgetSchema).default([]),
  cron: z.array(cronJobSchema).default([]),
});

export type SourceManifest = z.infer<typeof sourceManifestSchema>;
export type AppCapabilitiesShape = z.infer<typeof capabilitiesSchema>;

export type NormalizedWidget = {
  id: string;
  name: string;
  /** ESM module URL exposing `mount(element, props)`. */
  url: string;
  defaultSize: { w: number; h: number };
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
  /** Inbound webhook URL, when the webhook capability is enabled. */
  webhook?: { url: string };
  /** Blob storage base URL, when the storage capability is enabled. */
  storage?: { url: string };
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
    out.webhook = { url: webhookUrl(src.id) };
  }
  if (src.capabilities.storage) {
    out.storage = { url: storageUrl(src.id) };
  }
  return out;
}
