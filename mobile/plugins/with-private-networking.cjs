const { withAppDelegate } = require('expo/config-plugins');

module.exports = function withPrivateNetworking(config) {
  return withAppDelegate(config, (config) => {
    if (config.modResults.language !== 'swift') {
      throw new Error('Hatch private networking requires a Swift AppDelegate.');
    }
    const marker =
      '    // Hatch native requests must never persist credentials in URLCache.';
    if (config.modResults.contents.includes(marker)) return config;
    const anchor = '    let delegate = ReactNativeDelegate()';
    if (!config.modResults.contents.includes(anchor)) {
      throw new Error(
        'Cannot configure Hatch private networking in AppDelegate.',
      );
    }
    config.modResults.contents = config.modResults.contents.replace(
      anchor,
      `${marker}
    URLCache.shared.removeAllCachedResponses()
    URLCache.shared = URLCache(memoryCapacity: 0, diskCapacity: 0, diskPath: nil)
    if let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
       let bundleID = Bundle.main.bundleIdentifier {
      let legacyCache = caches.appendingPathComponent(bundleID, isDirectory: true)
      for name in ["Cache.db", "Cache.db-wal", "Cache.db-shm", "fsCachedData"] {
        try? FileManager.default.removeItem(at: legacyCache.appendingPathComponent(name))
      }
    }
    ExpoFetchCustomExtension.setCustomURLSessionConfigurationProvider {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.urlCache = nil
      configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
      configuration.httpCookieStorage = nil
      configuration.httpShouldSetCookies = false
      configuration.urlCredentialStorage = nil
      return configuration
    }

${anchor}`,
    );
    return config;
  });
};
