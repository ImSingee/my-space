import { getPasskeyRpId } from '~auth/passkey-origin';
import { getPlatformEnv } from '~env';
import { getTailscaleManager } from './tailscale-manager';

/** Public WebAuthn Related Origin Requests declaration for the canonical RP. */
export function passkeyRelatedOriginsResponse(): Response {
  const { appUrl } = getPlatformEnv();
  const origins = new Set<string>();
  if (getPasskeyRpId(appUrl)) {
    origins.add(appUrl);
    const tailscaleOrigin = getTailscaleManager().trustedOrigin();
    if (tailscaleOrigin && getPasskeyRpId(tailscaleOrigin)) {
      origins.add(tailscaleOrigin);
    }
  }
  return Response.json(
    { origins: [...origins] },
    // Never retain authorization for a disconnected or replaced node.
    { headers: { 'cache-control': 'no-store' } },
  );
}
