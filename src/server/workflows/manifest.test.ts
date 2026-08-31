import { describe, expect, it } from 'vitest';
import {
  normalizeWorkflowManifest,
  type NormalizedWorkflowManifest,
  parseSourceWorkflowManifest,
  projectWorkflowManifestUrls,
  workflowNetworkPolicyFromManifest,
  workflowWebhookUrl,
} from './manifest';

function manifest(network?: unknown): Record<string, unknown> {
  return {
    id: 'demo',
    name: 'Demo',
    ...(network === undefined ? {} : { network }),
  };
}

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
      version: 1,
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
