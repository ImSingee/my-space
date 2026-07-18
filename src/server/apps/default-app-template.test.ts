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
});
