import Foundation

struct CodexRefreshResponse: Sendable, Equatable {
    var accessToken: String
    var refreshToken: String?
    var idToken: String?
}

struct CodexUsageClient: Sendable {
    static let clientID = "app_EMoamEEZ73f0CkXaXp7hrann"
    static let refreshURL = URL(string: "https://auth.openai.com/oauth/token")!
    static let usageURL = URL(string: "https://chatgpt.com/backend-api/wham/usage")!

    var http: any HTTPClient

    init(http: any HTTPClient = URLSessionHTTPClient()) {
        self.http = http
    }

    func refreshToken(_ refreshToken: String) async throws -> CodexRefreshResponse {
        let body =
            "grant_type=refresh_token" +
            "&client_id=\(Self.clientID.urlFormEncoded)" +
            "&refresh_token=\(refreshToken.urlFormEncoded)"

        let response = try await http.send(HTTPRequest(
            method: "POST",
            url: Self.refreshURL,
            headers: ["Content-Type": "application/x-www-form-urlencoded"],
            body: Data(body.utf8),
            timeout: 15
        ))

        if response.statusCode == 400 || response.statusCode == 401 {
            let errorBody = ProviderParse.jsonObject(response.body)
            let code = errorBody?["error"].flatMap { errorValue -> String? in
                if let error = errorValue as? [String: Any] {
                    return error["code"] as? String ?? error["error"] as? String
                }
                return errorValue as? String
            } ?? errorBody?["code"] as? String

            switch code {
            case "refresh_token_expired":
                throw CodexAuthError.sessionExpired
            case "refresh_token_reused":
                throw CodexAuthError.tokenConflict
            case "refresh_token_invalidated":
                throw CodexAuthError.tokenRevoked
            default:
                throw CodexAuthError.tokenExpired
            }
        }

        guard (200..<300).contains(response.statusCode),
              let body = ProviderParse.jsonObject(response.body),
              let accessToken = body["access_token"] as? String,
              !accessToken.isEmpty
        else {
            throw CodexAuthError.tokenExpired
        }

        return CodexRefreshResponse(
            accessToken: accessToken,
            refreshToken: body["refresh_token"] as? String,
            idToken: body["id_token"] as? String
        )
    }

    func fetchUsage(accessToken: String, accountID: String?) async throws -> HTTPResponse {
        var headers = [
            "Authorization": "Bearer \(accessToken)",
            "Accept": "application/json",
            "User-Agent": "OpenUsage"
        ]
        if let accountID, !accountID.isEmpty {
            headers["ChatGPT-Account-Id"] = accountID
        }

        return try await http.send(HTTPRequest(
            method: "GET",
            url: Self.usageURL,
            headers: headers,
            timeout: 10
        ))
    }

}

