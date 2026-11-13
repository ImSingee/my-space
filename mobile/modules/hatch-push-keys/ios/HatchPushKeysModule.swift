import ExpoModulesCore
import Security

/// Keychain items readable by the Notification Service Extension. Both targets
/// list the same `keychain-access-groups` entry; its resolved name (with the
/// team prefix) is published in Info.plist as `HatchSharedKeychainGroup`.
enum HatchPushKeychain {
  static let service = "app.hatch.mobile.push-keys"

  static var accessGroup: String? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "HatchSharedKeychainGroup") as? String,
          !group.isEmpty, !group.contains("$(") else { return nil }
    return group
  }

  static func baseQuery(kid: String) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: kid,
    ]
    if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
    return query
  }
}

final class HatchPushKeyException: GenericException<OSStatus> {
  override var reason: String { "Keychain operation failed (\(param))." }
}

final class HatchPushKeyFormatException: Exception {
  override var reason: String { "Push key must be 32 bytes of base64url." }
}

public final class HatchPushKeysModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HatchPushKeys")

    AsyncFunction("setKey") { (kid: String, keyBase64url: String) in
      guard let data = Self.decodeBase64url(keyBase64url), data.count == 32 else {
        throw HatchPushKeyFormatException()
      }
      let query = HatchPushKeychain.baseQuery(kid: kid)
      SecItemDelete(query as CFDictionary)
      var item = query
      item[kSecValueData as String] = data
      // Pushes usually arrive while the phone is locked.
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let status = SecItemAdd(item as CFDictionary, nil)
      guard status == errSecSuccess else { throw HatchPushKeyException(status) }
    }

    AsyncFunction("deleteKey") { (kid: String) in
      let status = SecItemDelete(HatchPushKeychain.baseQuery(kid: kid) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw HatchPushKeyException(status)
      }
    }

    AsyncFunction("hasKey") { (kid: String) -> Bool in
      var query = HatchPushKeychain.baseQuery(kid: kid)
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }
  }

  private static func decodeBase64url(_ value: String) -> Data? {
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 { base64.append("=") }
    return Data(base64Encoded: base64)
  }
}
