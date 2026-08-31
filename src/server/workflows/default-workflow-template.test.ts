import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseSourceWorkflowManifest } from './manifest';

describe('default workflow template', () => {
  it('blocks network access until destinations are declared', async () => {
    const raw = await readFile(
      new URL(
        '../../../templates/default-workflow/manifest.json',
        import.meta.url,
      ),
      'utf8',
    );
    const rendered = raw
      .replaceAll('__WORKFLOW_ID__', 'demo')
      .replaceAll('__WORKFLOW_NAME__', 'Demo')
      .replaceAll('__WORKFLOW_DESCRIPTION__', 'Demo workflow');

    expect(parseSourceWorkflowManifest(JSON.parse(rendered)).network).toEqual(
      [],
    );
  });
});
