/** Server-only: scaffold a new subapp source tree from the template. */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { TEMPLATES_DIR, subappSrcDir } from '~agent/paths';
import { db, schema } from '~/db';
import type { JsonObject } from '~/db/schema';
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

export type CreateSubappInput = {
  id: string;
  name: string;
  description?: string;
};

export async function createSubapp(
  input: CreateSubappInput,
): Promise<{ id: string; name: string }> {
  const { id } = input;
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(
      'id must be kebab-case (lowercase letters, digits, hyphens).',
    );
  }

  const existing = await db.query.subapps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
  });
  if (existing) {
    throw new Error(`Subapp "${id}" already exists.`);
  }

  const src = subappSrcDir(id);
  if (existsSync(src)) {
    throw new Error(`Source directory subapps/${id} already exists.`);
  }

  const template = path.join(TEMPLATES_DIR, 'default-subapp');
  await fs.cp(template, src, { recursive: true });
  // Generated stubs are produced at build time, never copied from the template.
  await fs.rm(path.join(src, 'gen'), { recursive: true, force: true });

  const name = input.name.trim() || id;
  const description = (input.description ?? '').trim();

  await replaceInFile(path.join(src, 'manifest.json'), {
    __SUBAPP_ID__: id,
    __SUBAPP_NAME__: name,
    __SUBAPP_DESCRIPTION__: description,
  });
  await replaceInFile(path.join(src, 'app', 'index.html'), {
    __SUBAPP_NAME__: name,
  });

  const manifest = parseSourceManifest(
    JSON.parse(await fs.readFile(path.join(src, 'manifest.json'), 'utf8')),
  );

  await db.insert(schema.subapps).values({
    id,
    name,
    description: description || null,
    status: 'draft',
    capabilities: manifest.capabilities,
    manifest: manifest as unknown as JsonObject,
    backendMode: manifest.backendMode,
  });

  return { id, name };
}
