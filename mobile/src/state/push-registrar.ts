import { PushRegistrar } from '../core/push';
import { nativePushPlatform, pushSupported } from '../core/push-native';

export { pushSupported };

/** Process-wide registrar; serializes push changes per instance. */
export const pushRegistrar = new PushRegistrar(nativePushPlatform, {
  allowDevelopmentLoopback: __DEV__,
});
