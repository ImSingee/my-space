/** Shared source contract and platform deployment normalization. */
import { type NetworkPolicy } from '~/network-policy';
import {
  sourceManifestSchema,
  type SourceManifest,
  type AppCapabilitiesShape,
  type AppRoute,
  type CronJob,
  type WebhookAuth,
} from '../../../packages/hatch-manifest/src/app-schema.js';
export * from '../../../packages/hatch-manifest/src/app-schema.js';

/** A grid footprint in dashboard column/row units. */
export type GridSize = { w: number; h: number };

export type NormalizedWidget = {
  id: string;
  name: string;
  /** ESM module URL exposing `mount(element, context)`. */
  url: string;
  defaultSize: GridSize;
  /**
   * Discrete footprints the widget supports, de-duplicated in author order.
   * Empty means free-form resizing; non-empty makes the dashboard snap resizes
   * to the nearest entry. `defaultSize` is always one of these when non-empty.
   */
  supportedSizes: GridSize[];
};

/**
 * Nearest declared size to a target footprint, by Euclidean distance in grid
 * units (first entry wins ties). Returns `undefined` only for an empty list, so
 * callers can fall back to free-form behavior. Shared by manifest normalization
 * (to keep `defaultSize` valid) and the dashboard grid (to snap on resize).
 */
export function snapToSupportedSize<T extends GridSize>(
  sizes: readonly T[],
  target: GridSize,
): T | undefined {
  let best: T | undefined;
  let bestScore = Infinity;
  for (const size of sizes) {
    const dw = size.w - target.w;
    const dh = size.h - target.h;
    const score = dw * dw + dh * dh;
    if (score < bestScore) {
      bestScore = score;
      best = size;
    }
  }
  return best;
}

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
  capabilities: AppCapabilitiesShape;
  backendMode: 'serverless' | 'long-running';
  /** Backend artifact entry the platform runs, when a backend is present. */
  backend?: {
    entry: string;
    /** Absent on legacy source artifacts; set by the bundle build path. */
    format?: 'bundle-v1';
    /** Absent on legacy deployments, which retain unrestricted access. */
    network?: NetworkPolicy;
  };
  /**
   * Full-App URL and discoverable routes, when present. Stored deployment
   * manifests use the stable id-based asset URL; projected read models expose
   * the canonical user-facing `/app/<slug>` URL.
   */
  app?: {
    url: string;
    /** Optional only for normalized manifests persisted before route metadata. */
    routes?: AppRoute[];
  };
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
  /** KV REST base URL, when the kv capability is enabled. */
  kv?: { url: string };
  /** Managed Data Table REST/SSE base URL. */
  dataTable?: { url: string };
  /**
   * The app's declared RPC API, captured from its proto at build time. Absent
   * for apps without an RPC service. Lets the platform (and the manage UI) know
   * exactly which services + methods an app exposes.
   */
  api?: AppApi;
};

/** Root path the platform serves an app's runtime APIs and assets under. */
export function appBasePath(id: string): string {
  return `/api/app/${id}`;
}

/** Stable id-based asset URL persisted in deployment manifests. */
export function appAssetUrl(id: string): string {
  return `${appBasePath(id)}/app/`;
}

/**
 * Project every app-owned URL from authoritative app identity at read time.
 * Deployment manifests are immutable, may contain legacy `/api/apps/...`
 * values, and are keyed by id while slugs may change without a rebuild. Every
 * outward-facing manifest view therefore derives fresh canonical URLs rather
 * than trusting or rewriting the stored JSONB artifact.
 */
export function projectAppManifestUrls(
  manifest: NormalizedManifest,
  appId: string,
  slug: string,
): NormalizedManifest {
  return {
    ...manifest,
    ...(manifest.app
      ? {
          app: {
            ...manifest.app,
            url: `/app/${slug}`,
          },
        }
      : {}),
    ...(manifest.widgets
      ? {
          widgets: manifest.widgets.map((widget) => ({
            ...widget,
            url: widgetUrl(appId, widget.id),
          })),
        }
      : {}),
    ...(manifest.rpc ? { rpc: { ...manifest.rpc, url: rpcUrl(appId) } } : {}),
    ...(manifest.kv ? { kv: { url: kvUrl(appId) } } : {}),
    ...(manifest.dataTable ? { dataTable: { url: dataTableUrl(appId) } } : {}),
    ...(manifest.capabilities?.webhook || manifest.webhook
      ? {
          webhook: {
            url: webhookUrl(appId),
            auth: manifest.webhook?.auth ?? 'platform',
          },
        }
      : {}),
  };
}

export function widgetUrl(id: string, widgetId: string): string {
  return `${appBasePath(id)}/widget/${widgetId}`;
}

export function rpcUrl(id: string): string {
  return `${appBasePath(id)}/rpc`;
}

/** Per-app KV REST base. The backend calls it with an HMAC signature. */
export function kvUrl(id: string): string {
  return `${appBasePath(id)}/kv`;
}

/** Managed Data Table API base used by browsers and app backends. */
export function dataTableUrl(id: string): string {
  return `${appBasePath(id)}/data`;
}

/** Public inbound webhook URL (token appended at call time as `?secret=`). */
export function webhookUrl(id: string): string {
  return `${appBasePath(id)}/hook`;
}

/** Parse + validate raw manifest JSON authored by the Agent. */
export function parseSourceManifest(raw: unknown): SourceManifest {
  return sourceManifestSchema.parse(raw);
}

/** Resolve a source widget into its deploy-time shape (URL + sized footprints). */
function normalizeWidget(
  appId: string,
  widget: SourceManifest['widgets'][number],
): NormalizedWidget {
  const seen = new Set<string>();
  const supportedSizes: GridSize[] = [];
  for (const size of widget.supportedSizes) {
    const key = `${size.w}x${size.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    supportedSizes.push({ w: size.w, h: size.h });
  }
  // Keep the opening size inside the supported set so a freshly placed widget
  // never starts at a footprint its own resize rules would immediately snap away.
  let defaultSize: GridSize = {
    w: widget.defaultSize.w,
    h: widget.defaultSize.h,
  };
  if (
    supportedSizes.length > 0 &&
    !seen.has(`${defaultSize.w}x${defaultSize.h}`)
  ) {
    defaultSize =
      snapToSupportedSize(supportedSizes, defaultSize) ?? defaultSize;
  }
  return {
    id: widget.id,
    name: widget.name,
    url: widgetUrl(appId, widget.id),
    defaultSize,
    supportedSizes,
  };
}

/** Produce the deploy-time manifest with concrete platform URLs. */
export function normalizeManifest(src: SourceManifest): NormalizedManifest {
  const out: NormalizedManifest = {
    id: src.id,
    name: src.name,
    description: src.description,
    capabilities: src.capabilities,
    backendMode: src.backendMode,
    widgets: src.capabilities.widgets
      ? src.widgets.map((w) => normalizeWidget(src.id, w))
      : [],
    cron: src.capabilities.cron ? src.cron : [],
  };
  if (src.capabilities.backend && src.backend) {
    out.backend = {
      entry: src.backend.entry,
      ...(src.backend.network === undefined
        ? {}
        : { network: src.backend.network }),
    };
  }
  if (src.capabilities.frontend && src.app) {
    out.app = { url: appAssetUrl(src.id), routes: src.app.routes };
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
  // KV is reachable only from the app's own backend over the HMAC-signed route
  // (a signing secret is minted only for backend apps), so like rpc / workflow
  // calls it's meaningful only when a backend is actually staged. Without this
  // gate a backendless app would advertise a KV URL that always 404s.
  if (src.capabilities.kv && src.capabilities.backend && src.backend) {
    out.kv = { url: kvUrl(src.id) };
  }
  if (src.capabilities.dataTable) {
    out.dataTable = { url: dataTableUrl(src.id) };
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
