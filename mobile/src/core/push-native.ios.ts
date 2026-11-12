import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { requireOptionalNativeModule } from 'expo';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { parsePushRecord, type PushPlatform } from './push';

type HatchPushKeysModule = {
  setKey(kid: string, key: string): Promise<void>;
  hasKey(kid: string): Promise<boolean>;
  deleteKey(kid: string): Promise<void>;
};

const nativeKeys =
  requireOptionalNativeModule<HatchPushKeysModule>('HatchPushKeys');

// App-private copy of each instance's push key; the extension reads its own
// copy from the shared keychain group written by HatchPushKeys.
const recordOptions: SecureStore.SecureStoreOptions = {
  keychainService: 'app.hatch.mobile.push',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

async function recordKey(origin: string) {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    origin,
  );
  return `hatch.mobile.push.v1.${digest.toLowerCase()}`;
}

function keys(): HatchPushKeysModule {
  if (!nativeKeys)
    throw new Error('Push notifications need a newer build of this app.');
  return nativeKeys;
}

export const pushSupported = Boolean(nativeKeys);

export const nativePushPlatform: PushPlatform = {
  environment:
    Constants.expoConfig?.extra?.apnsEnvironment === 'production'
      ? 'production'
      : 'sandbox',
  deviceName: () => Constants.deviceName ?? 'iPhone',
  async permission(prompt) {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (!prompt || !current.canAskAgain) return false;
    const next = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: false, allowSound: true },
    });
    return next.granted;
  },
  async apnsToken() {
    const token = await Notifications.getDevicePushTokenAsync();
    return String(token.data);
  },
  randomBytes: (count) => Crypto.getRandomBytes(count),
  sharedKeys: {
    set: (kid, key) => keys().setKey(kid, key),
    has: (kid) => keys().hasKey(kid),
    remove: (kid) => keys().deleteKey(kid),
  },
  records: {
    async get(origin) {
      return parsePushRecord(
        await SecureStore.getItemAsync(await recordKey(origin), recordOptions),
      );
    },
    async set(origin, record) {
      await SecureStore.setItemAsync(
        await recordKey(origin),
        JSON.stringify(record),
        recordOptions,
      );
    },
    async remove(origin) {
      await SecureStore.deleteItemAsync(await recordKey(origin), recordOptions);
    },
  },
};
