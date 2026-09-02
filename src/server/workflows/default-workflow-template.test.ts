import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { LATEST_WORKFLOW_COMPATIBILITY_VERSION } from '~/workflow-compatibility';
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
    const source = JSON.parse(rendered) as Record<string, unknown>;

    expect(source).not.toHaveProperty('version');
    expect(source.compatibilityVersion).toBe(
      LATEST_WORKFLOW_COMPATIBILITY_VERSION,
    );
    expect(parseSourceWorkflowManifest(source)).toMatchObject({
      compatibilityVersion: LATEST_WORKFLOW_COMPATIBILITY_VERSION,
      network: [],
    });
  });
});
