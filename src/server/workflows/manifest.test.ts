import { describe, expect, it } from 'vitest';
import {
  isValidWorkflowId,
  isValidWorkflowSlug,
  normalizeWorkflowManifest,
  type NormalizedWorkflowManifest,
  parseSourceWorkflowManifest,
  projectWorkflowManifestUrls,
  workflowNetworkPolicyFromManifest,
  workflowWebhookUrl,
} from './manifest';

describe('Workflow identity manifest', () => {
  it('accepts generated and legacy immutable Workflow ids', () => {
    const generatedId = '01k43s9az5t2qpy7ejf0hm6vwc';

    expect(isValidWorkflowId(generatedId)).toBe(true);
    expect(isValidWorkflowId('legacy-kebab-id')).toBe(true);
    expect(
      parseSourceWorkflowManifest({
        id: generatedId,
        name: 'Demo',
        compatibilityVersion: 1,
      }).id,
    ).toBe(generatedId);
  });

  it('keeps mutable slug validation separate from immutable id validation', () => {
    expect(isValidWorkflowId('01k43s9az5t2qpy7ejf0hm6vwc')).toBe(true);
    expect(isValidWorkflowSlug('01k43s9az5t2qpy7ejf0hm6vwc')).toBe(false);
    expect(isValidWorkflowSlug('daily-digest')).toBe(true);
    expect(isValidWorkflowId('../daily-digest')).toBe(false);
  });
});

function manifest(network?: unknown): Record<string, unknown> {
  return {
    id: 'demo',
    name: 'Demo',
    compatibilityVersion: 1,
    ...(network === undefined ? {} : { network }),
  };
}

describe('Workflow manifest compatibility version', () => {
  it('requires an explicit positive integer', () => {
    const { compatibilityVersion: _compatibilityVersion, ...missing } =
      manifest();

    expect(() => parseSourceWorkflowManifest(missing)).toThrow(
      /compatibilityVersion/,
    );
    for (const compatibilityVersion of [0, -1, 1.5, '1', null]) {
      expect(() =>
        parseSourceWorkflowManifest({
          ...manifest(),
          compatibilityVersion,
        }),
      ).toThrow(/compatibilityVersion/);
    }
  });

  it('preserves the declared version in the source manifest', () => {
    expect(parseSourceWorkflowManifest(manifest()).compatibilityVersion).toBe(
      1,
    );
  });

  it('accepts the retired field without adding it to normalized manifests', () => {
    const retiredVersion = { legacy: true };
    const parsed = parseSourceWorkflowManifest({
      ...manifest(),
      version: retiredVersion,
    });

    expect(parsed.version).toEqual(retiredVersion);
    expect(normalizeWorkflowManifest(parsed)).not.toHaveProperty('version');
  });
});

describe('Workflow manifest URLs', () => {
  it('uses the singular Workflow API namespace for run webhooks', () => {
    expect(workflowWebhookUrl('daily-digest')).toBe(
      '/api/workflow/daily-digest/run',
    );
  });

  it('projects a legacy stored webhook URL without mutating it', () => {
    const stored: NormalizedWorkflowManifest = {
      id: 'daily-digest',
      name: 'Daily digest',
      description: '',
      entry: 'workflow.ts',
      triggers: {
        cron: [],
        webhook: {
          enabled: true,
          url: '/api/workflow-hooks/daily-digest',
        },
      },
    };
    const before = structuredClone(stored);

    const projected = projectWorkflowManifestUrls(stored, 'daily-digest');

    expect(projected.triggers.webhook.url).toBe(
      '/api/workflow/daily-digest/run',
    );
    expect(stored).toEqual(before);
  });
});

describe('workflow network policy manifest', () => {
  it('preserves the missing legacy declaration as unrestricted', () => {
    const normalized = normalizeWorkflowManifest(
      parseSourceWorkflowManifest(manifest()),
    );
    expect(normalized).not.toHaveProperty('network');
    expect(workflowNetworkPolicyFromManifest(normalized)).toBeUndefined();
  });

  it.each([
    [[], []],
    [['API.EXAMPLE.COM:0443', 'api.example.com:443'], ['api.example.com:443']],
    ['unrestricted', 'unrestricted'],
  ])('normalizes and persists %j', (input, expected) => {
    const normalized = normalizeWorkflowManifest(
      parseSourceWorkflowManifest(manifest(input)),
    );
    expect(normalized.network).toEqual(expected);
    expect(workflowNetworkPolicyFromManifest(normalized)).toEqual(expected);
  });

  it('rejects invalid source and persisted declarations', () => {
    expect(() =>
      parseSourceWorkflowManifest(manifest(['https://example.com'])),
    ).toThrow(/must be a hostname/);
    expect(() =>
      workflowNetworkPolicyFromManifest({ network: ['10.0.0.0/8'] }),
    ).toThrow(/Invalid workflow network policy/);
  });
});
