/**
 * Tampermonkey `.user.js` assembly + request-time serving.
 *
 * The metadata-block builder is a pure function (unit-tested) that turns a
 * {@link NormalizedUserscript} plus request-derived fields into the
 * `// ==UserScript== ... // ==/UserScript==` header. The platform always owns
 * `@name`/`@namespace`/`@version`/`@updateURL`/`@downloadURL` and derives the
 * structured directives (`@match`, `@grant`, `@connect`, `@run-at`,
 * `@noframes`, `@description`) from dedicated manifest fields, so a manifest can
 * never inject or override them.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appBuildDir } from '~agent/paths';
import { secretsMatch } from '~server/secrets';
import type { NormalizedManifest, NormalizedUserscript } from './manifest';
import { userscriptDownloadPath, userscriptNamespace } from './manifest';

/** Runtime-derived fields the platform fills in for every generated script. */
export type UserscriptRenderContext = {
  /**
   * `@version`; the app's monotonic userscript revision (bumped on deploy and
   * rollback) drives auto-update.
   */
  version: number | string;
  /** Absolute `@namespace` (stable across origins). */
  namespace: string;
  /** Absolute tokenized `@downloadURL` / `@updateURL`. */
  downloadUrl: string;
  updateUrl: string;
};

/** Collapse any line breaks so a value can't inject extra metadata lines. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** `// @key value` (value optional for flag directives like `@noframes`). */
function directive(key: string, value?: string): string {
  return value === undefined ? `// @${key}` : `// @${key} ${oneLine(value)}`;
}

/**
 * Build the Tampermonkey metadata block for a userscript. Pure and
 * deterministic: platform-owned directives first, then the author's structured
 * directives, then advanced `extraMetadata`, and finally the update/download
 * URLs. Every value is single-lined defensively even though the manifest schema
 * already rejects line breaks.
 */
export function buildUserscriptMetadataBlock(
  script: NormalizedUserscript,
  ctx: UserscriptRenderContext,
): string {
  const lines: string[] = ['// ==UserScript=='];
  lines.push(directive('name', script.name));
  lines.push(directive('namespace', ctx.namespace));
  lines.push(directive('version', String(ctx.version)));
  if (script.description)
    lines.push(directive('description', script.description));
  for (const match of script.matches) lines.push(directive('match', match));
  if (script.runAt) lines.push(directive('run-at', script.runAt));
  if (script.noframes) lines.push(directive('noframes'));
  for (const connect of script.connects)
    lines.push(directive('connect', connect));
  // Empty grants => omit so Tampermonkey auto-detects; ['none'] => page context.
  for (const grant of script.grants) lines.push(directive('grant', grant));
  for (const [key, raw] of Object.entries(script.extraMetadata)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) lines.push(directive(key, value));
  }
  lines.push(directive('updateURL', ctx.updateUrl));
  lines.push(directive('downloadURL', ctx.downloadUrl));
  lines.push('// ==/UserScript==');
  return lines.join('\n');
}

/** Full `.user.js` document: metadata block followed by the bundled body. */
export function renderUserscript(
  script: NormalizedUserscript,
  ctx: UserscriptRenderContext,
  body: string,
): string {
  return `${buildUserscriptMetadataBlock(script, ctx)}\n\n${body}`;
}

/** Outcome of a `.user.js` request, mapped to an HTTP status by the route. */
export type UserscriptDownloadResult =
  | { ok: true; body: string }
  | { ok: false; reason: 'not_found' | 'forbidden' };

/**
 * Resolve and render a userscript for a public `.user.js` request. Auth is the
 * app-level token (not a platform session) so Tampermonkey background updates
 * keep working. Serves only a live, non-archived, userscripts-capable app whose
 * current deployment declares the requested script id, and only when the token
 * matches the app's minted secret.
 */
export async function resolveUserscriptDownload(
  id: string,
  scriptId: string,
  token: string | null,
  origin: string,
): Promise<UserscriptDownloadResult> {
  // Imported lazily so the pure metadata builder above stays free of the DB
  // (and unit-testable without a DATABASE_URL).
  const { db } = await import('~/db');
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
    columns: {
      status: true,
      capabilities: true,
      currentDeploymentId: true,
      userscriptSecret: true,
      userscriptRevision: true,
    },
  });
  // Gate on a live deployment (not status === 'deployed') so a redeploy keeps
  // serving the previous build, matching the widget/webhook routes. Reject
  // archived / never-deployed / capability-off apps reached via a stale URL.
  if (
    !app ||
    app.status === 'archived' ||
    !app.currentDeploymentId ||
    !app.capabilities?.userscripts ||
    !app.userscriptSecret
  ) {
    return { ok: false, reason: 'not_found' };
  }
  if (!secretsMatch(token, app.userscriptSecret)) {
    return { ok: false, reason: 'forbidden' };
  }

  const deployment = await db.query.deployments.findFirst({
    where: (d, { eq }) => eq(d.id, app.currentDeploymentId as string),
    columns: { manifestNormalized: true },
  });
  const manifest = deployment?.manifestNormalized as NormalizedManifest | null;
  const script = manifest?.userscripts?.find((s) => s.id === scriptId);
  if (!script) return { ok: false, reason: 'not_found' };

  // scriptId matched a validated manifest slug, but keep the widget route's
  // defense-in-depth path check in case that invariant ever weakens.
  const userscriptsDir = path.join(appBuildDir(id), 'userscripts');
  const filePath = path.normalize(path.join(userscriptsDir, `${scriptId}.js`));
  if (!filePath.startsWith(userscriptsDir + path.sep)) {
    return { ok: false, reason: 'not_found' };
  }

  let body: string;
  try {
    body = await fs.readFile(filePath, 'utf8');
  } catch {
    return { ok: false, reason: 'not_found' };
  }

  // Re-encode the verified token into the update/download URLs so Tampermonkey
  // re-requests the exact same secret on every auto-update.
  const downloadUrl = `${origin}${userscriptDownloadPath(id, scriptId)}?token=${encodeURIComponent(
    app.userscriptSecret,
  )}`;
  return {
    ok: true,
    body: renderUserscript(
      script,
      {
        // The app-level revision, NOT the deployment version: it increments on
        // every activation (deploy and rollback alike), so Tampermonkey — which
        // only updates when the remote version increases — also picks up
        // rollbacks, where the deployment version goes backwards.
        version: Math.max(app.userscriptRevision, 1),
        namespace: userscriptNamespace(id, scriptId),
        downloadUrl,
        updateUrl: downloadUrl,
      },
      body,
    ),
  };
}
