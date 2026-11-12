const fs = require('node:fs');
const path = require('node:path');
const {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins');

const TARGET = 'HatchNotificationService';
const SHARED_GROUP_SUFFIX = 'app.hatch.mobile.shared';
const SHARED_GROUP = `$(AppIdentifierPrefix)${SHARED_GROUP_SUFFIX}`;
const KEYCHAIN_SERVICE = 'app.hatch.mobile.push-keys';
const UNVERIFIED_BODY = 'Notification from an unverified source';

// Decrypts Hatch's end-to-end encrypted pushes. Apple only ever sees the
// placeholder alert and ciphertext; anything that fails authentication is
// shown as unverified with every sender-controlled field removed.
const SWIFT = `import CryptoKit
import Foundation
import Security
import UserNotifications

private struct HatchPushPlaintext: Decodable {
  let v: Int
  let id: String
  let o: String
  let t: String
  let b: String?
  let s: String
  let k: String
  let g: String
  let u: String?
  let at: String
}

final class NotificationService: UNNotificationServiceExtension {
  private var deliver: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let unverified = Self.unverified(request.content)
    deliver = contentHandler
    fallback = unverified
    contentHandler(Self.decrypt(request.content, key: Self.key(for:)) ?? unverified)
    deliver = nil
  }

  override func serviceExtensionTimeWillExpire() {
    if let deliver, let fallback { deliver(fallback) }
    deliver = nil
  }

  static func unverified(_ original: UNNotificationContent) -> UNNotificationContent {
    let content = UNMutableNotificationContent()
    content.title = "Hatch"
    content.body = "${UNVERIFIED_BODY}"
    content.sound = original.sound
    content.threadIdentifier = "hatch.unverified"
    content.userInfo = [:]
    return content
  }

  private static func sharedGroup() -> String? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "HatchSharedKeychainGroup") as? String,
          !group.isEmpty, !group.contains("$(") else { return nil }
    return group
  }

  static func key(for kid: String) -> SymmetricKey? {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "${KEYCHAIN_SERVICE}",
      kSecAttrAccount as String: kid,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    if let group = sharedGroup() { query[kSecAttrAccessGroup as String] = group }
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data, data.count == 32 else { return nil }
    return SymmetricKey(data: data)
  }

  /// Returns nil unless the payload authenticates with this phone's key.
  static func decrypt(
    _ original: UNNotificationContent, key lookup: (String) -> SymmetricKey?
  ) -> UNNotificationContent? {
    guard let envelope = original.userInfo["h"] as? [String: Any],
          (envelope["v"] as? Int) == 1,
          let kid = envelope["kid"] as? String,
          kid.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil,
          let sealed = envelope["c"] as? String,
          let combined = Data(base64Encoded: sealed),
          let key = lookup(kid),
          let box = try? AES.GCM.SealedBox(combined: combined),
          let plain = try? AES.GCM.open(
            box, using: key, authenticating: Data("hatch-push-v1|\\(kid)".utf8)),
          let message = try? JSONDecoder().decode(HatchPushPlaintext.self, from: plain),
          message.v == 1, !message.id.isEmpty,
          let origin = URL(string: message.o), ["https", "http"].contains(origin.scheme ?? "")
    else { return nil }

    let content = UNMutableNotificationContent()
    content.title = message.t
    content.subtitle = "\\(message.s) · \\(message.k)"
    content.body = message.b ?? ""
    content.sound = original.sound
    content.threadIdentifier = "\\(message.o)|\\(message.g)"
    // expo-notifications exposes a remote push's \`body\` dictionary as \`data\`.
    var data: [String: Any] = ["hatchNotificationId": message.id, "hatchOrigin": message.o]
    if let url = message.u { data["hatchUrl"] = url }
    content.userInfo = ["body": data]
    return content
  }
}
`;

function extensionInfoPlist(version, buildNumber) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>Hatch Notifications</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${buildNumber}</string>
  <key>HatchSharedKeychainGroup</key>
  <string>${SHARED_GROUP}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>
</dict>
</plist>
`;
}

const EXTENSION_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>keychain-access-groups</key>
  <array>
    <string>${SHARED_GROUP}</string>
  </array>
</dict>
</plist>
`;

function withMainAppKeychain(config) {
  config = withEntitlementsPlist(config, (config) => {
    // Keep the app's own group first: it stays the default for every other
    // keychain item (session tokens never move into the shared group).
    const own = '$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)';
    const groups = Array.isArray(config.modResults['keychain-access-groups'])
      ? config.modResults['keychain-access-groups']
      : [];
    const next = [own, ...groups.filter((group) => group !== own)];
    if (!next.includes(SHARED_GROUP)) next.push(SHARED_GROUP);
    config.modResults['keychain-access-groups'] = next;
    return config;
  });
  return withInfoPlist(config, (config) => {
    config.modResults.HatchSharedKeychainGroup = SHARED_GROUP;
    return config;
  });
}

function withExtensionFiles(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const dir = path.join(config.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'NotificationService.swift'), SWIFT);
      fs.writeFileSync(
        path.join(dir, 'Info.plist'),
        extensionInfoPlist(
          config.version ?? '1.0.0',
          config.ios?.buildNumber ?? '1',
        ),
      );
      fs.writeFileSync(
        path.join(dir, `${TARGET}.entitlements`),
        EXTENSION_ENTITLEMENTS,
      );
      return config;
    },
  ]);
}

function withExtensionTarget(config, { bundleIdentifier }) {
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    if (project.pbxTargetByName(TARGET)) return config;

    const objects = project.hash.project.objects;
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};

    // Info.plist and entitlements are referenced by build settings only; as
    // group files they would be copied into the bundle as resources.
    const group = project.addPbxGroup(
      ['NotificationService.swift'],
      TARGET,
      TARGET,
    );
    const mainGroup = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(group.uuid, mainGroup);

    const target = project.addTarget(
      TARGET,
      'app_extension',
      TARGET,
      bundleIdentifier,
    );
    project.addBuildPhase(
      ['NotificationService.swift'],
      'PBXSourcesBuildPhase',
      'Sources',
      target.uuid,
    );
    project.addBuildPhase(
      [],
      'PBXResourcesBuildPhase',
      'Resources',
      target.uuid,
    );
    project.addBuildPhase(
      [],
      'PBXFrameworksBuildPhase',
      'Frameworks',
      target.uuid,
    );

    const mainSettings = Object.values(
      project.pbxXCBuildConfigurationSection(),
    ).find(
      (entry) =>
        entry?.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER &&
        entry.buildSettings.PRODUCT_BUNDLE_IDENTIFIER.replaceAll('"', '') ===
          config.ios?.bundleIdentifier,
    )?.buildSettings;

    for (const entry of Object.values(
      project.pbxXCBuildConfigurationSection(),
    )) {
      if (entry?.buildSettings?.PRODUCT_NAME !== `"${TARGET}"`) continue;
      Object.assign(entry.buildSettings, {
        INFOPLIST_FILE: `${TARGET}/Info.plist`,
        CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
        CODE_SIGN_STYLE: 'Automatic',
        IPHONEOS_DEPLOYMENT_TARGET:
          config.ios?.deploymentTarget ??
          mainSettings?.IPHONEOS_DEPLOYMENT_TARGET ??
          '16.4',
        SWIFT_VERSION: '5.0',
        TARGETED_DEVICE_FAMILY: '"1,2"',
        GENERATE_INFOPLIST_FILE: 'NO',
        ...(mainSettings?.DEVELOPMENT_TEAM
          ? { DEVELOPMENT_TEAM: mainSettings.DEVELOPMENT_TEAM }
          : {}),
      });
    }
    return config;
  });
}

/** Adds the iOS Notification Service Extension that decrypts Hatch pushes. */
module.exports = function withNotificationServiceExtension(config) {
  const bundleIdentifier = `${config.ios?.bundleIdentifier ?? 'app.hatch.mobile'}.NotificationService`;
  config = withMainAppKeychain(config);
  config = withExtensionFiles(config);
  config = withExtensionTarget(config, { bundleIdentifier });
  return config;
};
