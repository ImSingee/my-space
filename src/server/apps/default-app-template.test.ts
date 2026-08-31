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
  return parseSourceManifest(JSON.parse(rendered));
}

describe('default app template', () => {
  it('uses a managed Data Table instead of a raw App database', async () => {
    const manifest = await loadDefaultManifest();
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
    expect(manifest.backend?.network).toEqual([]);
    expect(backend).toContain('createDataClient<typeof schema>');
    expect(backend).toContain("Deno.env.get('HATCH_DATA_URL')");
    expect(backend).not.toContain('DATABASE_URL');
    expect(backend).toContain(".listen(port, '127.0.0.1'");
    expect(backend).toContain(
      "data.increment('counters', id, 'value', amount)",
    );
    expect(backend).not.toMatch(/\bindex\s*:/);
    expect(counter).not.toContain('current.value + amount');
    expect(dataSchema).toContain("uniqueIndex('by_name', ['name'])");
  });
});
