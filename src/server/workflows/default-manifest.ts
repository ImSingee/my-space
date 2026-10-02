import { parseSourceWorkflowManifest } from './manifest';

/** Trusted defaults shared by draft initialization and template rendering. */
export function defaultWorkflowManifest(
  id: string,
  name: string,
  description: string,
) {
  return parseSourceWorkflowManifest({
    id,
    name,
    description,
    compatibilityVersion: 1,
    entry: 'workflow.ts',
    network: [],
    triggers: {
      cron: [],
      webhook: false,
    },
  });
}
