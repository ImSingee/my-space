import { evaluateTemplateManifest } from '../../test-manifest-fixture';
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
    const rendered = raw
      .replace('__WORKFLOW_ID__', JSON.stringify('demo'))
      .replace('__WORKFLOW_NAME__', JSON.stringify('Demo'))
      .replace('__WORKFLOW_DESCRIPTION__', JSON.stringify('Demo workflow'));
    const source = await evaluateTemplateManifest(rendered, 'workflow');

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
