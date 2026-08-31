import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_SLUG_MAX_LENGTH } from '~/workflow-identity';

const mocks = vi.hoisted(() => ({
  ensureWorkflowRepo: vi.fn<(id: string) => Promise<string>>(
    async (id) => `/test/workflow-repos/${id}.git`,
  ),
}));

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

vi.mock('./git', () => ({
  ensureWorkflowRepo: mocks.ensureWorkflowRepo,
}));

const { db, schema } = await import('~/db');
const { createWorkflow } = await import('./scaffold');

function renderedFile(
  files: Awaited<ReturnType<typeof createWorkflow>>['files'],
  filePath: string,
): string {
  const file = files.find((candidate) => candidate.path === filePath);
  if (!file) throw new Error(`Missing rendered file: ${filePath}`);
  return Buffer.from(file.contentBase64, 'base64').toString('utf8');
}

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(schema.workflows);
});

describe('createWorkflow', () => {
  it('generates an immutable id and uses the slug only for human-facing state', async () => {
    const created = await createWorkflow({
      slug: 'daily-digest',
      name: 'Daily digest',
    });

    expect(created).toMatchObject({
      slug: 'daily-digest',
      name: 'Daily digest',
    });
    expect(created.id).toMatch(/^[0-9a-z]{26}$/);
    expect(created.id).not.toBe(created.slug);
    expect(
      JSON.parse(renderedFile(created.files, 'manifest.json')),
    ).toMatchObject({ id: created.id, name: 'Daily digest' });
    expect(
      JSON.parse(renderedFile(created.files, 'package.json')),
    ).toMatchObject({ name: 'daily-digest' });
    expect(mocks.ensureWorkflowRepo).toHaveBeenCalledWith(created.id);
    await expect(db.query.workflows.findFirst()).resolves.toMatchObject({
      id: created.id,
      slug: 'daily-digest',
      name: 'Daily digest',
      repoPath: `/test/workflow-repos/${created.id}.git`,
      manifest: { id: created.id },
    });
  });

  it('rejects a duplicate slug but allows a slug equal to another Workflow id', async () => {
    await db.insert(schema.workflows).values({
      id: 'legacy-kebab-id',
      slug: 'taken-slug',
      name: 'Existing workflow',
    });

    await expect(
      createWorkflow({ slug: 'taken-slug', name: 'Duplicate' }),
    ).rejects.toThrow('Slug "taken-slug" is already in use.');

    const created = await createWorkflow({
      slug: 'legacy-kebab-id',
      name: 'Independent namespaces',
    });
    expect(created.slug).toBe('legacy-kebab-id');
    expect(created.id).not.toBe('legacy-kebab-id');
  });

  it('rejects invalid slugs before creating repository or database state', async () => {
    await expect(
      createWorkflow({ slug: '01numeric-slug', name: 'Invalid' }),
    ).rejects.toThrow('slug must be kebab-case');
    await expect(
      createWorkflow({
        slug: `a${'b'.repeat(WORKFLOW_SLUG_MAX_LENGTH)}`,
        name: 'Too long',
      }),
    ).rejects.toThrow(
      `slug must be at most ${WORKFLOW_SLUG_MAX_LENGTH} characters`,
    );

    expect(mocks.ensureWorkflowRepo).not.toHaveBeenCalled();
    await expect(db.query.workflows.findMany()).resolves.toEqual([]);
  });
});
