import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const { createApp, renderTemplate } = await import('./scaffold');
const tempDirs: string[] = [];

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

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('renderTemplate', () => {
  it('excludes every case variant of a reserved .hatch segment', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-template-'));
    tempDirs.push(root);
    await Promise.all([
      fs.mkdir(path.join(root, '.HATCH'), { recursive: true }),
      fs.mkdir(path.join(root, 'nested', '.HaTcH'), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(root, 'keep.txt'), 'keep'),
      fs.writeFile(path.join(root, '.HATCH', 'secret.txt'), 'drop'),
      fs.writeFile(path.join(root, 'nested', 'keep.txt'), 'keep'),
      fs.writeFile(path.join(root, 'nested', '.HaTcH', 'secret.txt'), 'drop'),
    ]);

    const files = await renderTemplate(root, {}, { exclude: ['.hatch'] });

    expect(files.map((file) => file.path).sort()).toEqual([
      'keep.txt',
      'nested/keep.txt',
    ]);
  });
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
