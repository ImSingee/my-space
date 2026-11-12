import type { PushPlatform } from './push';

const unsupported = () =>
  Promise.reject(new Error('Push notifications are available on iOS only.'));

/** Android has no shareable push credentials yet; push stays off. */
export const pushSupported = false;

export const nativePushPlatform: PushPlatform = {
  environment: 'production',
  deviceName: () => 'Android',
  permission: () => Promise.resolve(false),
  apnsToken: unsupported,
  randomBytes: () => new Uint8Array(),
  sharedKeys: { set: unsupported, has: unsupported, remove: unsupported },
  records: {
    get: () => Promise.resolve(null),
    set: unsupported,
    remove: () => Promise.resolve(),
  },
};
