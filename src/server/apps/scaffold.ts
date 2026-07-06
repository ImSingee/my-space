/** Server-only: scaffold a new app source tree from the template. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { TEMPLATES_DIR } from '~agent/paths';
import type { ScaffoldFile } from '~agent/protocol';
import { db, schema } from '~/db';
import type { JsonObject } from '~/db/schema';
import { slugConflictExists } from './access';
import { ensureAppRepo } from './git';
import { isValidAppSlug, parseSourceManifest } from './manifest';

/**
 * Escape a value for insertion *inside* an existing pair of JSON quotes (the
 * template already supplies the surrounding `"`). Without this, a name or
 * description containing `"`/newline/etc. produces invalid manifest.json.
 */
function jsonStringInner(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function applyReplacements(
  text: string,
  replacements: Record<string, string>,
): string {
  let out = text;
  for (const [token, value] of Object.entries(replacements)) {
    out = out.split(token).join(value);
  }
  return out;
}

/**
 * Read a template directory into an in-memory file map, applying token
 * substitutions to the given (text) files. The map is returned to the Agent
 * Runner, which writes it into its own worktree — the platform no longer
 * writes agent worktrees itself.
 */
export async function renderTemplate(
  templateDir: string,
  substitutions: Record<string, Record<string, string>>,
  opts: { exclude?: string[] } = {},
): Promise<ScaffoldFile[]> {
  const files: ScaffoldFile[] = [];
  const excluded = new Set(opts.exclude ?? []);

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excluded.has(rel)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const subs = substitutions[rel];
      const content = subs
        ? Buffer.from(
            applyReplacements(await fs.readFile(abs, 'utf8'), subs),
            'utf8',
          )
        : await fs.readFile(abs);
      files.push({ path: rel, contentBase64: content.toString('base64') });
    }
  }

  await walk(templateDir, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function fileContent(files: ScaffoldFile[], rel: string): string {
  const file = files.find((f) => f.path === rel);
  if (!file) throw new Error(`Template is missing ${rel}.`);
  return Buffer.from(file.contentBase64, 'base64').toString('utf8');
}

export type CreateAppInput = {
  /**
   * Mutable, human-facing URL slug (kebab-case). The immutable internal `id`
   * is generated here (a ULID) and is independent of the slug.
   */
  slug: string;
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

export type CreateAppResult = {
  id: string;
  slug: string;
  name: string;
  /** Rendered template for the caller to write into its own worktree. */
  files: ScaffoldFile[];
};

/**
 * Register a new app: validate the slug, mint the immutable id, create the
 * canonical bare repo and the database row, and render the scaffold template.
 * The rendered files are RETURNED, not written — the Agent Runner (or a
 * script) writes them into its own checkout and commits from there.
 */
export async function createApp(
  input: CreateAppInput,
): Promise<CreateAppResult> {
  const slug = input.slug.trim();
  if (!isValidAppSlug(slug)) {
    throw new Error(
      'slug must be kebab-case (lowercase letters, digits, and hyphens, ' +
        'starting with a letter).',
    );
  }

  if (await slugConflictExists(slug)) {
    throw new Error(
      `Slug "${slug}" conflicts with an existing app's id or slug.`,
    );
  }

  // The id is an immutable internal key, independent of the mutable slug.
  const id = ulid().toLowerCase();
  const repoPath = await ensureAppRepo(id);

  const name = input.name.trim() || slug;
  const description = (input.description ?? '').trim();

  const files = await renderTemplate(
    path.join(TEMPLATES_DIR, 'default-app'),
    {
      'manifest.json': {
        __APP_ID__: jsonStringInner(id),
        __APP_NAME__: jsonStringInner(name),
        __APP_DESCRIPTION__: jsonStringInner(description),
      },
      // package.json `name` is never published; the kebab-case slug is a
      // valid, readable npm name, so a plain substitution is safe.
      'package.json': { __APP_ID__: slug },
      'app/index.html': { __APP_NAME__: name },
    },
    // Generated stubs are produced at build time, never copied from the
    // template.
    { exclude: ['gen'] },
  );

  const manifest = parseSourceManifest(
    JSON.parse(fileContent(files, 'manifest.json')),
  );

  await db.insert(schema.apps).values({
    id,
    slug,
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

  return { id, slug, name, files };
}
