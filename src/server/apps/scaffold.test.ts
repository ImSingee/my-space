import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureAppRepo: vi.fn<(id: string) => Promise<string>>(
    async (id) => `/test/repos/${id}.git`,
  ),
}));

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

// Creating a bare Git repository is the only filesystem mutation in createApp.
// Keep real, read-only template rendering so the returned scaffold is covered.
vi.mock('./git', () => ({ ensureAppRepo: mocks.ensureAppRepo }));

const { db, schema } = await import('~/db');
const { createApp } = await import('./scaffold');

function renderedFile(
  files: Awaited<ReturnType<typeof createApp>>['files'],
  filePath: string,
): string {
  const file = files.find((candidate) => candidate.path === filePath);
  if (!file) throw new Error(`Missing rendered file: ${filePath}`);
  return Buffer.from(file.contentBase64, 'base64').toString('utf8');
}

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(schema.apps);
});

describe('createApp', () => {
  it('returns the default scaffold without assigning draft capabilities', async () => {
    const result = await createApp({
      slug: 'hello-world',
      name: 'Hello "World"',
      description: 'First line\nSecond line',
    });

    const manifest = JSON.parse(renderedFile(result.files, 'manifest.json'));
    expect(manifest).toMatchObject({
      id: result.id,
      name: 'Hello "World"',
      description: 'First line\nSecond line',
      backendMode: 'serverless',
      capabilities: {
        frontend: true,
        widgets: true,
        backend: true,
        dataTable: true,
      },
    });
    expect(
      JSON.parse(renderedFile(result.files, 'package.json')),
    ).toMatchObject({ name: 'hello-world' });
    expect(renderedFile(result.files, 'app/index.html')).toContain(
      '<title>Hello "World"</title>',
    );
    expect(result.files.some((file) => file.path.startsWith('gen/'))).toBe(
      false,
    );

    expect(mocks.ensureAppRepo).toHaveBeenCalledOnce();
    expect(mocks.ensureAppRepo).toHaveBeenCalledWith(result.id);
    await expect(db.query.apps.findFirst()).resolves.toMatchObject({
      id: result.id,
      slug: 'hello-world',
      name: 'Hello "World"',
      description: 'First line\nSecond line',
      status: 'draft',
      capabilities: null,
      manifest: null,
      backendMode: null,
      currentDeploymentId: null,
      repoPath: `/test/repos/${result.id}.git`,
    });
    await expect(db.query.sidebarItems.findMany()).resolves.toMatchObject([
      {
        appId: result.id,
        label: 'Hello "World"',
        sortOrder: 0,
      },
    ]);
  });

  it('honors an explicit request not to pin the draft', async () => {
    const result = await createApp({
      slug: 'unlisted-app',
      name: 'Unlisted App',
      pin: false,
    });

    await expect(db.query.apps.findFirst()).resolves.toMatchObject({
      id: result.id,
      capabilities: null,
      manifest: null,
      backendMode: null,
      currentDeploymentId: null,
    });
    await expect(db.query.sidebarItems.findMany()).resolves.toEqual([]);
  });
});
