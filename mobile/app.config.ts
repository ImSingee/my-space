import type { ExpoConfig } from 'expo/config';

// Store/TestFlight builds talk to production APNs; development clients and
// Simulator builds receive sandbox tokens. The app registers its token with
// the matching environment so the instance picks the right APNs host and key.
const apnsEnvironment =
  process.env.EAS_BUILD_PROFILE === 'production' ||
  process.env.HATCH_APNS_ENVIRONMENT === 'production'
    ? 'production'
    : 'sandbox';

const config: ExpoConfig = {
  name: 'Hatch',
  slug: 'hatch-mobile',
  owner: 'singee',
  extra: {
    apnsEnvironment,
    eas: {
      projectId: '2ed99159-8abc-41eb-91a5-c6c754bb4354',
      build: {
        experimental: {
          ios: {
            appExtensions: [
              {
                targetName: 'HatchNotificationService',
                bundleIdentifier: 'app.hatch.mobile.NotificationService',
                entitlements: {
                  'keychain-access-groups': [
                    '$(AppIdentifierPrefix)app.hatch.mobile.shared',
                  ],
                },
              },
            ],
          },
        },
      },
    },
  },
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
    [
      'expo-notifications',
      {
        mode: apnsEnvironment === 'production' ? 'production' : 'development',
      },
    ],
    './plugins/with-notification-service-extension.cjs',
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
