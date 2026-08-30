import { describe, expect, it } from 'vitest';
import {
  type NormalizedWorkflowManifest,
  projectWorkflowManifestUrls,
  workflowWebhookUrl,
} from './manifest';

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
