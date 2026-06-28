/** Server-only: scaffold a new workflow source tree from the template. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TEMPLATES_DIR } from '~agent/paths';
import { db, schema } from '~/db';
import type { JsonObject } from '~/db/schema';
import { checkoutWorkflowForAgent, ensureWorkflowRepo } from './git';
import { parseSourceWorkflowManifest } from './manifest';

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

export type CreateWorkflowInput = {
  id: string;
  name: string;
  description?: string;
  /** Pin the new workflow to the sidebar (default true). */
  pin?: boolean;
};

export type CreateWorkflowOptions = {
  sessionId?: string;
};

export async function createWorkflow(
  input: CreateWorkflowInput,
  options: CreateWorkflowOptions = {},
): Promise<{ id: string; name: string }> {
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
  if (!options.sessionId) {
    throw new Error('A chat session is required to scaffold a workflow.');
  }
  const checkout = await checkoutWorkflowForAgent(options.sessionId, id);
  const src = checkout.absolutePath;

  const template = path.join(TEMPLATES_DIR, 'default-workflow');
  await fs.cp(template, src, { recursive: true });

  const name = input.name.trim() || id;
  const description = (input.description ?? '').trim();

  await replaceInFile(path.join(src, 'manifest.json'), {
    __WORKFLOW_ID__: jsonStringInner(id),
    __WORKFLOW_NAME__: jsonStringInner(name),
    __WORKFLOW_DESCRIPTION__: jsonStringInner(description),
  });

  const manifest = parseSourceWorkflowManifest(
    JSON.parse(await fs.readFile(path.join(src, 'manifest.json'), 'utf8')),
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

  return { id, name };
}
