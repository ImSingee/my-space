import { z } from 'zod';

export const HOMEPAGE_PAGES = [
  { value: 'dashboard', label: 'Default Dashboard' },
  { value: 'agent', label: 'Agent' },
  { value: 'apps', label: 'Apps' },
  { value: 'dashboards', label: 'Dashboards' },
  { value: 'workflows', label: 'Workflows' },
  { value: 'executions', label: 'Executions' },
  { value: 'settings', label: 'Settings' },
] as const;

const resourceId = z.string().min(1).max(200);

export const homepageTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('page'),
      page: z.enum(HOMEPAGE_PAGES.map((page) => page.value)),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dashboard'),
      dashboardId: resourceId,
    })
    .strict(),
  z
    .object({
      kind: z.literal('app'),
      appId: resourceId,
      // The fragment belongs to the App's hash router, never the host URL.
      entryHash: z.string().max(512).nullable(),
    })
    .strict(),
]);

export type HomepageTarget = z.infer<typeof homepageTargetSchema>;
export const DEFAULT_HOMEPAGE: HomepageTarget = {
  kind: 'page',
  page: 'dashboard',
};
