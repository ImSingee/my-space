/** Server-only: scaffold a new workflow source tree from the template. */
import path from 'node:path';
import { TEMPLATES_DIR } from '~agent/paths';
import type { ScaffoldFile } from '~agent/protocol';
import { db, schema } from '~/db';
import type { JsonObject } from '~/db/schema';
import { renderTemplate } from '../apps/scaffold';
import { ensureWorkflowRepo } from './git';
import { parseSourceWorkflowManifest } from './manifest';

/**
 * Escape a value for insertion *inside* an existing pair of JSON quotes (the
 * template already supplies the surrounding `"`). Without this, a name or
 * description containing `"`/newline/etc. produces invalid manifest.json.
 */
function jsonStringInner(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export type CreateWorkflowInput = {
  id: string;
  name: string;
  description?: string;
  /** Pin the new workflow to the sidebar (default true). */
  pin?: boolean;
};

export type CreateWorkflowResult = {
  id: string;
  name: string;
  /** Rendered template for the caller to write into its own worktree. */
  files: ScaffoldFile[];
};

/**
 * Register a new workflow: validate the id, create the canonical bare repo
 * and the database row, and render the scaffold template. The rendered files
 * are RETURNED, not written — the Agent Runner writes them into its own
 * checkout and commits from there.
 */
export async function createWorkflow(
  input: CreateWorkflowInput,
): Promise<CreateWorkflowResult> {
  const { id } = input;
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(
      'id must be kebab-case (lowercase letters, digits, hyphens).',
    );
  }

  const existing = await db.query.workflows.findFirst({
    where: (s, { eq }) => eq(s.id, id),
  });
  if (existing) {
    throw new Error(`Workflow "${id}" already exists.`);
  }

  const repoPath = await ensureWorkflowRepo(id);

  const name = input.name.trim() || id;
  const description = (input.description ?? '').trim();

  const files = await renderTemplate(
    path.join(TEMPLATES_DIR, 'default-workflow'),
    {
      'manifest.json': {
        __WORKFLOW_ID__: jsonStringInner(id),
        __WORKFLOW_NAME__: jsonStringInner(name),
        __WORKFLOW_DESCRIPTION__: jsonStringInner(description),
      },
    },
  );

  const manifestFile = files.find((f) => f.path === 'manifest.json');
  if (!manifestFile) throw new Error('Template is missing manifest.json.');
  const manifest = parseSourceWorkflowManifest(
    JSON.parse(
      Buffer.from(manifestFile.contentBase64, 'base64').toString('utf8'),
    ),
  );

  await db.insert(schema.workflows).values({
    id,
    name,
    description: description || null,
    status: 'draft',
    manifest: manifest as unknown as JsonObject,
    repoPath,
    pinned: input.pin ?? true,
  });

  return { id, name, files };
}
