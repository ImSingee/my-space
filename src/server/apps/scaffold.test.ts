import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_NAME_MAX_LENGTH, APP_SLUG_MAX_LENGTH } from '~/app-identity';

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
  await db.delete(schema.agentSessions);
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
  it('rejects a duplicate slug but allows a slug equal to another App id', async () => {
    await db.insert(schema.apps).values({
      id: 'legacy-kebab-id',
      slug: 'taken-slug',
      name: 'Existing App',
    });

    await expect(
      createApp({ slug: 'taken-slug', name: 'Duplicate', pin: false }),
    ).rejects.toThrow('Slug "taken-slug" is already in use.');

    const created = await createApp({
      slug: 'legacy-kebab-id',
      name: 'Independent namespaces',
      pin: false,
    });

    expect(created.slug).toBe('legacy-kebab-id');
    expect(created.id).not.toBe('legacy-kebab-id');
  });

  it.each([
    {
      input: {
        slug: `a${'b'.repeat(APP_SLUG_MAX_LENGTH)}`,
        name: 'Valid name',
      },
      message: `slug must be at most ${APP_SLUG_MAX_LENGTH} characters`,
    },
    {
      input: {
        slug: 'valid-slug',
        name: '😀'.repeat(APP_NAME_MAX_LENGTH + 1),
      },
      message: `name must be at most ${APP_NAME_MAX_LENGTH} characters`,
    },
  ])(
    'rejects an oversized identity before creating repository or database state',
    async ({ input, message }) => {
      await expect(createApp(input)).rejects.toThrow(message);

      expect(mocks.ensureAppRepo).not.toHaveBeenCalled();
      await expect(db.query.apps.findMany()).resolves.toEqual([]);
      await expect(db.query.sidebarItems.findMany()).resolves.toEqual([]);
    },
  );

  it('counts astral Unicode names as one character per code point', async () => {
    const name = '😀'.repeat(APP_NAME_MAX_LENGTH);

    const result = await createApp({ slug: 'unicode-name', name, pin: false });

    expect(result.name).toBe(name);
    await expect(db.query.apps.findFirst()).resolves.toMatchObject({ name });
  });

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
      compatibilityVersion: 2,
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

  it('creates the requesting conversation association atomically with the App', async () => {
    await db
      .insert(schema.agentSessions)
      .values({ id: 'creating-session', title: 'Creating session' });

    const result = await createApp(
      { slug: 'associated-app', name: 'Associated App', pin: false },
      { sessionId: 'creating-session' },
    );

    await expect(db.select().from(schema.agentSessionApps)).resolves.toEqual([
      { sessionId: 'creating-session', appId: result.id },
    ]);
  });

  it('rejects an unknown requesting conversation before creating App state', async () => {
    await expect(
      createApp(
        { slug: 'orphan-app', name: 'Orphan App', pin: false },
        { sessionId: 'missing-session' },
      ),
    ).rejects.toThrow('Agent session not found.');

    expect(mocks.ensureAppRepo).not.toHaveBeenCalled();
    await expect(db.query.apps.findMany()).resolves.toEqual([]);
    await expect(db.select().from(schema.agentSessionApps)).resolves.toEqual(
      [],
    );
  });
});
