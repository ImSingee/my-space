/** Server-only: scaffold a new workflow source tree from the template. */
import path from 'node:path';
import { ulid } from 'ulid';
import { TEMPLATES_DIR } from '~agent/paths';
import type { ScaffoldFile } from '~agent/protocol';
import { db, schema } from '~/db';
import type { JsonObject } from '~/db/schema';
import { WORKFLOW_SLUG_MAX_LENGTH } from '~/workflow-identity';
import { renderTemplate } from '../apps/scaffold';
import { workflowSlugExists } from './access';
import { ensureWorkflowRepo } from './git';
import { isValidWorkflowSlug, parseSourceWorkflowManifest } from './manifest';

/**
 * Escape a value for insertion *inside* an existing pair of JSON quotes (the
 * template already supplies the surrounding `"`). Without this, a name or
 * description containing `"`/newline/etc. produces invalid manifest.json.
 */
function jsonStringInner(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export type CreateWorkflowInput = {
  /** Mutable human-facing URL slug; the immutable id is generated here. */
  slug: string;
  name: string;
  description?: string;
  /** Pin the new workflow to the sidebar (default true). */
  pin?: boolean;
};

export type CreateWorkflowResult = {
  id: string;
  slug: string;
  name: string;
  /** Rendered template for the caller to write into its own worktree. */
  files: ScaffoldFile[];
};

/**
 * Register a new workflow: validate the slug, mint the immutable id, create the
 * canonical bare repo and database row, and render the scaffold template. The
 * rendered files are RETURNED, not written — the Agent Runner writes them into
 * its own checkout and commits from there.
 */
export async function createWorkflow(
  input: CreateWorkflowInput,
): Promise<CreateWorkflowResult> {
  const slug = input.slug.trim();
  if (slug.length > WORKFLOW_SLUG_MAX_LENGTH) {
    throw new Error(
      `slug must be at most ${WORKFLOW_SLUG_MAX_LENGTH} characters.`,
    );
  }
  if (!isValidWorkflowSlug(slug)) {
    throw new Error(
      'slug must be kebab-case (lowercase letters, digits, and hyphens, ' +
        'starting with a letter).',
    );
  }

  if (await workflowSlugExists(slug)) {
    throw new Error(`Slug "${slug}" is already in use.`);
  }

  const id = ulid().toLowerCase();
  const repoPath = await ensureWorkflowRepo(id);

  const name = input.name.trim() || slug;
  const description = (input.description ?? '').trim();

  const files = await renderTemplate(
    path.join(TEMPLATES_DIR, 'default-workflow'),
    {
      'manifest.json': {
        __WORKFLOW_ID__: jsonStringInner(id),
        __WORKFLOW_NAME__: jsonStringInner(name),
        __WORKFLOW_DESCRIPTION__: jsonStringInner(description),
      },
      'package.json': { __WORKFLOW_ID__: slug },
    },
  );

  const manifestFile = files.find((f) => f.path === 'manifest.json');
  if (!manifestFile) throw new Error('Template is missing manifest.json.');
  const manifest = parseSourceWorkflowManifest(
    JSON.parse(
      Buffer.from(manifestFile.contentBase64, 'base64').toString('utf8'),
    ),
  );

  const [created] = await db
    .insert(schema.workflows)
    .values({
      id,
      slug,
      name,
      description: description || null,
      status: 'draft',
      manifest: manifest as unknown as JsonObject,
      repoPath,
      pinned: input.pin ?? true,
    })
    .returning({ id: schema.workflows.id });
  if (!created) throw new Error('Failed to create workflow.');

  return {
    id,
    slug,
    name,
    files,
  };
}
