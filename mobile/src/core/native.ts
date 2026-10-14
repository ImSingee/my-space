import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { fetch } from 'expo/fetch';
import { HatchApiClient } from './client';
import type { ClientOptions, FetchLike } from './client';
import { InstanceVault } from './vault';
import type { InstanceUrlOptions } from './security';

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainService: 'app.hatch.mobile.credentials',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export function createNativeVault(
  options: InstanceUrlOptions = {},
): InstanceVault {
  return new InstanceVault(
    {
      get: (key) => SecureStore.getItemAsync(key, secureOptions),
      set: (key, value) => SecureStore.setItemAsync(key, value, secureOptions),
      remove: (key) => SecureStore.deleteItemAsync(key, secureOptions),
    },
    (value) =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
    {
      allowDevelopmentLoopback:
        __DEV__ && options.allowDevelopmentLoopback === true,
    },
  );
}

export function createNativeClient(
  options: Omit<ClientOptions, 'fetch'>,
): HatchApiClient {
  return new HatchApiClient({
    ...options,
    fetch: fetch as FetchLike,
    allowDevelopmentLoopback:
      __DEV__ && options.allowDevelopmentLoopback === true,
  });
}

/** Verification URL has already been validated by DeviceLogin; no token is passed. */
export function openLoginBrowser(
  url: string,
): Promise<WebBrowser.WebBrowserResult> {
  return WebBrowser.openBrowserAsync(url, {
    presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
  });
}
