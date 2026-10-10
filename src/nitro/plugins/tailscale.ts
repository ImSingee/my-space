import { definePlugin } from 'nitro';
import { isSpaShellPrerendering } from '~env';
import { getTailscaleManager } from '~server/tailscale-manager';
import { purgeAppAccessCodes } from '~server/apps/app-access';

export default definePlugin((app) => {
  if (isSpaShellPrerendering()) return;
  const timer = setInterval(() => {
    void purgeAppAccessCodes().catch(() => {});
  }, 60_000);
  timer.unref();
  app.hooks.hook('close', async () => {
    clearInterval(timer);
    await getTailscaleManager().shutdown();
  });
});
