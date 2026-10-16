import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Hatch',
  slug: 'hatch-mobile',
  version: '0.1.0',
  scheme: 'hatch',
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: false,
    deploymentTarget: '16.4',
    bundleIdentifier: 'app.hatch.mobile',
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      UIViewControllerBasedStatusBarAppearance: true,
    },
  },
  android: { package: 'app.hatch.mobile' },
  plugins: [
    './plugins/with-private-networking.cjs',
    'expo-router',
    'expo-secure-store',
    'expo-status-bar',
    'expo-web-browser',
    ['expo-dev-client', { launchMode: 'launcher' }],
    [
      'expo-image-picker',
      {
        photosPermission: 'Choose images to attach to your Hatch conversation.',
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
  ],
  experiments: { typedRoutes: true },
};
export default config;
