import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseSourceManifest } from './manifest';

async function loadDefaultManifest() {
  const template = await readFile(
    new URL('../../../templates/default-app/manifest.json', import.meta.url),
    'utf8',
  );
  const rendered = template
    .replaceAll('__APP_ID__', 'demo')
    .replaceAll('__APP_NAME__', 'Demo')
    .replaceAll('__APP_DESCRIPTION__', 'Demo app');
  const source = JSON.parse(rendered) as {
    widgets: Record<string, unknown>[];
  };
  return { source, manifest: parseSourceManifest(source) };
}

async function renderDefaultIndexHtml() {
  const template = await readFile(
    new URL('../../../templates/default-app/app/index.html', import.meta.url),
    'utf8',
  );
  return template.replaceAll('__APP_NAME__', 'Demo');
}

describe('default app template', () => {
  it('declares the scaffolded TanStack Router routes', async () => {
    const { manifest } = await loadDefaultManifest();

    expect(manifest.app?.routes).toEqual([
      { path: '/', description: 'Persistent counter' },
      { path: '/about', description: 'About this app' },
    ]);
  });

  it('leaves the scaffolded widget free-form by default', async () => {
    const { source, manifest } = await loadDefaultManifest();

    expect(source.widgets[0]).not.toHaveProperty('supportedSizes');
    expect(manifest.widgets[0]).toMatchObject({
      defaultSize: { w: 4, h: 3 },
      supportedSizes: [],
    });
  });

  it('uses a managed Data Table instead of a raw App database', async () => {
    const { manifest } = await loadDefaultManifest();
    const template = new URL(
      '../../../templates/default-app/',
      import.meta.url,
    );
    const [backend, counter, dataSchema] = await Promise.all([
      readFile(new URL('backend/main.ts', template), 'utf8'),
      readFile(new URL('backend/counter.ts', template), 'utf8'),
      readFile(new URL('data/schema.ts', template), 'utf8'),
    ]);

    expect(manifest.capabilities).toMatchObject({
      database: false,
      dataTable: true,
    });
    expect(backend).toContain('createDataClient<typeof schema>');
    expect(backend).toContain("Deno.env.get('HATCH_DATA_URL')");
    expect(backend).not.toContain('DATABASE_URL');
    expect(backend).toContain(
      "data.increment('counters', id, 'value', amount)",
    );
    expect(backend).not.toMatch(/\bindex\s*:/);
    expect(counter).not.toContain('current.value + amount');
    expect(dataSchema).toContain("uniqueIndex('by_name', ['name'])");
  });

  it('uses the Hatch-provided Data SDK outside the App dependency graph', async () => {
    const template = new URL(
      '../../../templates/default-app/',
      import.meta.url,
    );
    const [packageJson, denoJson, lock, gitignore] = await Promise.all([
      readFile(new URL('package.json', template), 'utf8'),
      readFile(new URL('deno.json', template), 'utf8'),
      readFile(new URL('deno.lock', template), 'utf8'),
      readFile(new URL('.gitignore', template), 'utf8'),
    ]);
    const manifest = JSON.parse(packageJson) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies).not.toHaveProperty('@hatch/data');
    expect(manifest.dependencies).not.toHaveProperty('postgres');
    expect(JSON.parse(denoJson)).toEqual({ allowScripts: [] });
    expect(lock).not.toContain('@hatch/data');
    expect(gitignore).toMatch(/^node_modules\/$/m);
  });

  it('renders the scaffolded app with light-only color support', async () => {
    const html = await renderDefaultIndexHtml();

    expect(html).toContain('<title>Demo</title>');
    expect(html).toContain('color-scheme: light;');
    expect(html).not.toContain('color-scheme: light dark');
    expect(html).not.toContain('prefers-color-scheme: dark');
  });
});
