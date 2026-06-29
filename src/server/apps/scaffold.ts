/** Server-only: scaffold a new app source tree from the template. */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { TEMPLATES_DIR, appSrcDir } from '~agent/paths';
import { db, schema } from '~/db';
import type { JsonObject } from '~/db/schema';
import { checkoutAppForAgent, ensureAppRepo } from './git';
import { parseSourceManifest } from './manifest';

async function replaceInFile(
  file: string,
  replacements: Record<string, string>,
): Promise<void> {
  let text = await fs.readFile(file, 'utf8');
  for (const [token, value] of Object.entries(replacements)) {
    text = text.split(token).join(value);
  }
  await fs.writeFile(file, text, 'utf8');
}

/**
 * Escape a value for insertion *inside* an existing pair of JSON quotes (the
 * template already supplies the surrounding `"`). Without this, a name or
 * description containing `"`/newline/etc. produces invalid manifest.json.
 */
function jsonStringInner(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export type CreateAppInput = {
  id: string;
  name: string;
  description?: string;
  /**
   * Whether to pin the new app to the sidebar. Defaults to the scaffolded
   * manifest's `frontend` capability. The template is always frontend-capable,
   * so in practice frontend apps are pinned on creation and the Agent opts out
   * (`pin: false`) for backend-only / widget-only apps.
   */
  pin?: boolean;
};

export type CreateAppOptions = {
  sessionId?: string;
};

export async function createApp(
  input: CreateAppInput,
  options: CreateAppOptions = {},
): Promise<{ id: string; name: string }> {
  const { id } = input;
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(
      'id must be kebab-case (lowercase letters, digits, hyphens).',
    );
  }

  const existing = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
  });
  if (existing) {
    throw new Error(`App "${id}" already exists.`);
  }

  const repoPath = await ensureAppRepo(id);
  const checkout = options.sessionId
    ? await checkoutAppForAgent(options.sessionId, id)
    : null;
  const src = checkout?.absolutePath ?? appSrcDir(id);
  if (!checkout && existsSync(src)) {
    throw new Error(`Source directory apps/${id} already exists.`);
  }

  const template = path.join(TEMPLATES_DIR, 'default-app');
  await fs.cp(template, src, { recursive: true });
  // Generated stubs are produced at build time, never copied from the template.
  await fs.rm(path.join(src, 'gen'), { recursive: true, force: true });

  const name = input.name.trim() || id;
  const description = (input.description ?? '').trim();

  await replaceInFile(path.join(src, 'manifest.json'), {
    __APP_ID__: jsonStringInner(id),
    __APP_NAME__: jsonStringInner(name),
    __APP_DESCRIPTION__: jsonStringInner(description),
  });
  // package.json `name` is never published; the app id is already a valid npm
  // name (kebab-case), so a plain substitution is safe.
  await replaceInFile(path.join(src, 'package.json'), {
    __APP_ID__: id,
  });
  await replaceInFile(path.join(src, 'app', 'index.html'), {
    __APP_NAME__: name,
  });

  const manifest = parseSourceManifest(
    JSON.parse(await fs.readFile(path.join(src, 'manifest.json'), 'utf8')),
  );

  await db.insert(schema.apps).values({
    id,
    name,
    description: description || null,
    status: 'draft',
    capabilities: manifest.capabilities,
    manifest: manifest as unknown as JsonObject,
    repoPath,
    backendMode: manifest.backendMode,
  });

  // Pin frontend apps to the sidebar so a freshly created app is reachable
  // immediately. The scaffold always declares a frontend, so the choice is
  // really the Agent's: it passes `pin: false` for backend-only / widget-only
  // apps. Mirrors the insert in `setSidebarPin`.
  const shouldPin = input.pin ?? manifest.capabilities.frontend;
  if (shouldPin) {
    const pins = await db.query.sidebarItems.findMany();
    await db
      .insert(schema.sidebarItems)
      .values({
        appId: id,
        label: name,
        sortOrder: pins.length,
      })
      .onConflictDoNothing();
  }

  return { id, name };
}
