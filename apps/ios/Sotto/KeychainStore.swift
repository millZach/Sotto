import Foundation
import Security
import SottoCore

/// JSON decoding is shared by the app and tests; only the Keychain byte operations are replaceable.
struct KeychainStore {
    struct UndecodableItem: Error { let account: String }
    private static let service = "Sotto.host-client"
    private let readData: (String) throws -> Data?
    private let writeData: (Data, String) throws -> Void
    private let removeItem: (String) throws -> Void
    private let listAccounts: () throws -> [String]
    init(readData: @escaping (String) throws -> Data? = KeychainStore.readData,
         writeData: @escaping (Data, String) throws -> Void = KeychainStore.writeData,
         removeItem: @escaping (String) throws -> Void = KeychainStore.removeItem,
         listAccounts: @escaping () throws -> [String] = KeychainStore.listAccounts) {
        self.readData = readData; self.writeData = writeData
        self.removeItem = removeItem; self.listAccounts = listAccounts
    }
    func read<T: Decodable>(_ type: T.Type, account: String) throws -> T? {
        guard let data = try readData(account) else { return nil }
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw UndecodableItem(account: account) }
    }
    func write<T: Encodable>(_ value: T, account: String) throws {
        try writeData(JSONEncoder().encode(value), account)
    }
    func remove(account: String) throws { try removeItem(account) }
    func accounts() throws -> [String] { try listAccounts() }
    /// Verify writes before spending a one-use pairing code.
    func checkWritable() throws {
        let account = "pairing-storage-check"
        try write(true, account: account)
        try remove(account: account)
    }
    private static func readData(_ account: String) throws -> Data? {
        var query = base(account); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw failure }
        return data
    }
    private static func writeData(_ data: Data, _ account: String) throws {
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(base(account) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var query = base(account); attributes.forEach { query[$0] = $1 }
            guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw failure }
        } else if status != errSecSuccess { throw failure }
    }
    private static func removeItem(_ account: String) throws {
        let status = SecItemDelete(base(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw failure }
    }
    private static func listAccounts() throws -> [String] {
        var query = base(nil); query[kSecReturnAttributes as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitAll
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else { throw failure }
        return items.compactMap { $0[kSecAttrAccount as String] as? String }
    }
    private static func base(_ account: String?) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                  kSecAttrSynchronizable as String: false]
        if let account { query[kSecAttrAccount as String] = account }
        return query
    }
    /// Secure storage could not be opened, as against an item that is missing or undecodable.
    static let failure = ClientError.rejected("Sotto could not access secure storage. Unlock this iPhone and return to Sotto.")
}
