import { evaluateTemplateManifest } from '../../test-manifest-fixture';
import { defaultWorkflowManifest } from './default-manifest';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { LATEST_WORKFLOW_COMPATIBILITY_VERSION } from '~/workflow-compatibility';
import { parseSourceWorkflowManifest } from './manifest';

describe('default workflow template', () => {
  it('blocks network access until destinations are declared', async () => {
    const raw = await readFile(
      new URL(
        '../../../templates/default-workflow/manifest.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const expected = defaultWorkflowManifest('demo', 'Demo', 'Demo workflow');
    const rendered = raw.replace(
      '__WORKFLOW_MANIFEST__',
      JSON.stringify(expected),
    );
    const source = await evaluateTemplateManifest(rendered, 'workflow');
    expect(source).toEqual(expected);

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
