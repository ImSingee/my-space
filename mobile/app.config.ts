import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Hatch',
  slug: 'hatch-mobile',
  owner: 'singee',
  extra: { eas: { projectId: '2ed99159-8abc-41eb-91a5-c6c754bb4354' } },
  version: '0.1.0',
  icon: '../public/logo512.png',
  scheme: 'hatch',
  orientation: 'default',
  userInterfaceStyle: 'light',
  ios: {
    buildNumber: '3',
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
