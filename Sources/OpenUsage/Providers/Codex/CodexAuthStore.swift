import Foundation

struct CodexTokens: Codable, Hashable, Sendable {
    var accessToken: String?
    var refreshToken: String?
    var idToken: String?
    var accountID: String?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case idToken = "id_token"
        case accountID = "account_id"
    }
}

struct CodexAuth: Codable, Hashable, Sendable {
    var tokens: CodexTokens?
    var lastRefresh: String?
    var apiKey: String?

    enum CodingKeys: String, CodingKey {
        case tokens
        case lastRefresh = "last_refresh"
        case apiKey = "OPENAI_API_KEY"
    }
}

struct CodexAuthState: Hashable, Sendable {
    enum Source: Hashable, Sendable {
        case file(path: String)
        case keychain
    }

    var auth: CodexAuth
    var source: Source
}

enum CodexAuthError: Error, LocalizedError, Equatable {
    case notLoggedIn
    case sessionExpired
    case tokenConflict
    case tokenRevoked
    case tokenExpired
    case usageAPIKey
    case invalidAuthPayload

    var errorDescription: String? {
        switch self {
        case .notLoggedIn:
            return "Not logged in. Run `codex` to authenticate."
        case .sessionExpired:
            return "Session expired. Run `codex` to log in again."
        case .tokenConflict:
            return "Token conflict. Run `codex` to log in again."
        case .tokenRevoked:
            return "Token revoked. Run `codex` to log in again."
        case .tokenExpired:
            return "Token expired. Run `codex` to log in again."
        case .usageAPIKey:
            return "Usage not available for API key."
        case .invalidAuthPayload:
            return "Codex auth data is invalid."
        }
    }

    var allowsAuthFallback: Bool {
        switch self {
        case .sessionExpired, .tokenConflict, .tokenRevoked, .tokenExpired:
            return true
        case .notLoggedIn, .usageAPIKey, .invalidAuthPayload:
            return false
        }
    }
}

struct CodexAuthStore: Sendable {
    static let keychainService = "Codex Auth"
    private static let authFile = "auth.json"
    private static let defaultAuthHomes = ["~/.config/codex", "~/.codex"]

    var environment: EnvironmentReading
    var files: TextFileAccessing
    var keychain: KeychainAccessing
    var now: @Sendable () -> Date

    init(
        environment: EnvironmentReading = ProcessEnvironmentReader(),
        files: TextFileAccessing = LocalTextFileAccessor(),
        keychain: KeychainAccessing = SecurityKeychainAccessor(),
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.environment = environment
        self.files = files
        self.keychain = keychain
        self.now = now
    }

    func loadAuthCandidates() -> ([CodexAuthState], [String]) {
        var candidates: [CodexAuthState] = []
        var missing: [String] = []

        for path in authPaths() {
            guard files.exists(path) else {
                missing.append(path)
                continue
            }
            guard let text = try? files.readText(path),
                  let auth = Self.parseAuth(text),
                  Self.hasTokenLikeAuth(auth)
            else {
                continue
            }
            candidates.append(CodexAuthState(auth: auth, source: .file(path: path)))
        }

        return (candidates, missing)
    }

    func loadKeychainAuth() -> CodexAuthState? {
        guard let value = try? keychain.readGenericPassword(service: Self.keychainService),
              let auth = Self.parseAuth(value),
              Self.hasTokenLikeAuth(auth)
        else {
            return nil
        }
        return CodexAuthState(auth: auth, source: .keychain)
    }

    func save(_ state: CodexAuthState) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = state.source.isFile ? [.prettyPrinted, .sortedKeys] : []
        let data = try encoder.encode(state.auth)
        guard let text = String(data: data, encoding: .utf8) else {
            throw CodexAuthError.invalidAuthPayload
        }

        switch state.source {
        case .file(let path):
            try files.writeText(path, text)
        case .keychain:
            try keychain.writeGenericPassword(service: Self.keychainService, value: text)
        }
    }

    func needsRefresh(_ auth: CodexAuth) -> Bool {
        guard let lastRefresh = auth.lastRefresh,
              let date = OpenUsageISO8601.date(from: lastRefresh)
        else {
            return true
        }
        return now().timeIntervalSince(date) > 8 * 24 * 60 * 60
    }

    func authPaths() -> [String] {
        if let codexHome = codexHome() {
            return [joinPath(codexHome, Self.authFile)]
        }
        return Self.defaultAuthHomes.map { joinPath($0, Self.authFile) }
    }

    func codexHome() -> String? {
        guard let codexHome = environment.value(for: "CODEX_HOME")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !codexHome.isEmpty
        else {
            return nil
        }
        return codexHome
    }

    static func parseAuth(_ text: String) -> CodexAuth? {
        ProviderParse.decodeJSONWithHexFallback(text, as: CodexAuth.self)
    }

    static func hasTokenLikeAuth(_ auth: CodexAuth) -> Bool {
        if auth.tokens?.accessToken?.isEmpty == false { return true }
        if auth.apiKey?.isEmpty == false { return true }
        return false
    }

    private func joinPath(_ base: String, _ leaf: String) -> String {
        base.trimmingTrailingSlashes + "/" + leaf
    }
}

private extension CodexAuthState.Source {
    var isFile: Bool {
        if case .file = self { return true }
        return false
    }
}

