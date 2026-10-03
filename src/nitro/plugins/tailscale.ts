import { definePlugin } from 'nitro';
import { isSpaShellPrerendering } from '~env';
import { getTailscaleManager } from '~server/tailscale-manager';

export default definePlugin((app) => {
  if (isSpaShellPrerendering()) return;
  app.hooks.hook('close', () => getTailscaleManager().shutdown());
});
