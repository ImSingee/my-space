import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { WORKFLOW_SLUG_MAX_LENGTH } from '~/workflow-identity';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { workflowIdForSlug, workflowSlug, workflowSlugExists } =
  await import('./access');
const { renameWorkflowSlug } = await import('./manage');

beforeEach(async () => {
  await db.delete(schema.workflows);
  await db.insert(schema.workflows).values([
    {
      id: '01immutableworkflow',
      slug: 'human-readable-slug',
      name: 'Strict slug workflow',
    },
    {
      id: 'legacy-kebab-id',
      slug: 'second-slug',
      name: 'Legacy workflow',
    },
  ]);
});

describe('Workflow slug lookups', () => {
  it('resolves only the current slug to the immutable id', async () => {
    await expect(workflowIdForSlug('human-readable-slug')).resolves.toBe(
      '01immutableworkflow',
    );
    await expect(workflowIdForSlug('01immutableworkflow')).resolves.toBeNull();
    await expect(workflowIdForSlug('missing')).resolves.toBeNull();
    await expect(
      workflowIdForSlug(`a${'b'.repeat(WORKFLOW_SLUG_MAX_LENGTH)}`),
    ).resolves.toBeNull();
  });

  it('looks up the mutable slug by immutable id', async () => {
    await expect(workflowSlug('01immutableworkflow')).resolves.toBe(
      'human-readable-slug',
    );
    await expect(workflowSlug('human-readable-slug')).resolves.toBeNull();
  });

  it('checks only the Workflow slug namespace', async () => {
    await expect(workflowSlugExists('human-readable-slug')).resolves.toBe(true);
    await expect(workflowSlugExists('legacy-kebab-id')).resolves.toBe(false);
    await expect(
      workflowSlugExists('human-readable-slug', '01immutableworkflow'),
    ).resolves.toBe(false);
  });
});

describe('renameWorkflowSlug', () => {
  it('renames only the slug and permits a slug equal to another Workflow id', async () => {
    await expect(
      renameWorkflowSlug('01immutableworkflow', 'legacy-kebab-id'),
    ).resolves.toEqual({ slug: 'legacy-kebab-id' });

    const renamed = await db.query.workflows.findFirst({
      where: { id: '01immutableworkflow' },
    });
    expect(renamed).toMatchObject({
      id: '01immutableworkflow',
      slug: 'legacy-kebab-id',
      name: 'Strict slug workflow',
    });
  });

  it('rejects another Workflow slug without changing the current one', async () => {
    await expect(
      renameWorkflowSlug('01immutableworkflow', 'second-slug'),
    ).rejects.toThrow('Slug "second-slug" is already in use.');

    const current = await db.query.workflows.findFirst({
      where: { id: '01immutableworkflow' },
      columns: { slug: true },
    });
    expect(current?.slug).toBe('human-readable-slug');
  });

  it('does not rewrite manifest identity when the slug changes', async () => {
    await db
      .update(schema.workflows)
      .set({ manifest: { id: '01immutableworkflow' } })
      .where(eq(schema.workflows.id, '01immutableworkflow'));

    await renameWorkflowSlug('01immutableworkflow', 'renamed-workflow');

    const current = await db.query.workflows.findFirst({
      where: { id: '01immutableworkflow' },
      columns: { slug: true, manifest: true },
    });
    expect(current).toEqual({
      slug: 'renamed-workflow',
      manifest: { id: '01immutableworkflow' },
    });
  });
});
