import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseSourceManifest } from './manifest';

describe('default app template', () => {
  it('declares the scaffolded TanStack Router routes', async () => {
    const template = await readFile(
      new URL('../../../templates/default-app/manifest.json', import.meta.url),
      'utf8',
    );
    const rendered = template
      .replaceAll('__APP_ID__', 'demo')
      .replaceAll('__APP_NAME__', 'Demo')
      .replaceAll('__APP_DESCRIPTION__', 'Demo app');

    expect(parseSourceManifest(JSON.parse(rendered)).app?.routes).toEqual([
      { path: '/', description: 'Persistent counter' },
      { path: '/about', description: 'About this app' },
    ]);
  });
});
