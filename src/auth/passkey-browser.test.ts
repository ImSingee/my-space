import { afterEach, expect, test, vi } from 'vitest';
import {
  browserSupportsPasskeyAutofill,
  browserSupportsPasskeys,
} from './passkey-browser';

afterEach(() => vi.unstubAllGlobals());

test.each(['http://127.0.0.1:3700', 'http://[::1]:3700'])(
  'does not mistake trustworthy loopback %s for a valid relying party',
  async (origin) => {
    const checkAutofill = vi.fn<() => Promise<boolean>>(async () => true);
    vi.stubGlobal('window', {
      isSecureContext: true,
      location: new URL(origin),
      PublicKeyCredential: { isConditionalMediationAvailable: checkAutofill },
    });

    // Both a matching IP APP_URL and a domain APP_URL must hide the controls
    // when the actual browser location is an IP address.
    for (const appOrigin of [origin, 'http://localhost:3700']) {
      expect(browserSupportsPasskeys(appOrigin)).toBe(false);
      await expect(browserSupportsPasskeyAutofill(appOrigin)).resolves.toBe(
        false,
      );
    }
    expect(checkAutofill).not.toHaveBeenCalled();
  },
);
