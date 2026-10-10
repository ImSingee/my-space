import { defineWorkflowManifest } from '@hatch/workflow/manifest';

export default defineWorkflowManifest({
  id: __WORKFLOW_ID__,
  name: __WORKFLOW_NAME__,
  description: __WORKFLOW_DESCRIPTION__,
  compatibilityVersion: 1,
  entry: 'workflow.ts',
  network: [],
  triggers: {
    cron: [],
    webhook: false,
  },
});
