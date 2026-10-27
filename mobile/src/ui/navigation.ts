import { glyphs } from './glyph.types';

export const tabDetails = {
  dashboard: {
    label: 'Dashboard',
    glyph: 'dashboard',
    icon: glyphs.dashboard,
    androidIcon: 'dashboard',
    detail: 'Live widgets from your instance',
  },
  apps: {
    label: 'Apps',
    glyph: 'apps',
    icon: glyphs.apps,
    androidIcon: 'apps',
    detail: 'Pinned shortcuts and every App',
  },
  agent: {
    label: 'Agent',
    glyph: 'agent',
    icon: glyphs.agent,
    androidIcon: 'chat_bubble_outline',
    detail: 'Conversations with your Agent',
  },
  workflows: {
    label: 'Workflows',
    glyph: 'workflows',
    icon: glyphs.workflows,
    androidIcon: 'account_tree',
    detail: 'Pinned and all automations',
  },
} as const;
