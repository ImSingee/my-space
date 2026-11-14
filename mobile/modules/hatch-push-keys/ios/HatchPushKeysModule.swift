import CryptoKit
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

/// Tap fields the Notification Service Extension signs after decrypting a push
/// whose URL opens on tap (`tapSignature` in
/// plugins/with-notification-service-extension.cjs; keep both in sync). Only a
/// holder of this phone's key for the instance can produce the signature.
enum HatchPushTap {
  static func isValid(mac: String, origin: String, id: String, url: String, key: SymmetricKey) -> Bool {
    guard let code = Data(base64Encoded: mac) else { return false }
    let tapKey = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: key, info: Data("hatch-tap-v1".utf8), outputByteCount: 32)
    let message = "hatch-tap-v1|\(origin.utf8.count)|\(origin)|\(id.utf8.count)|\(id)|\(url.utf8.count)|\(url)"
    return HMAC<SHA256>.isValidAuthenticationCode(code, authenticating: Data(message.utf8), using: tapKey)
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

    AsyncFunction("verifyTap") {
      (kid: String, mac: String, origin: String, id: String, url: String) -> Bool in
      var query = HatchPushKeychain.baseQuery(kid: kid)
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      query[kSecReturnData as String] = true
      var item: CFTypeRef?
      guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
            let data = item as? Data, data.count == 32 else { return false }
      return HatchPushTap.isValid(
        mac: mac, origin: origin, id: id, url: url, key: SymmetricKey(data: data))
    }
  }

  private static func decodeBase64url(_ value: String) -> Data? {
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 { base64.append("=") }
    return Data(base64Encoded: base64)
  }
}
