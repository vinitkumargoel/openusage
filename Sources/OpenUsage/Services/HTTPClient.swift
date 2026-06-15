import Foundation

struct HTTPRequest: Sendable {
    var method: String
    var url: URL
    var headers: [String: String] = [:]
    var body: Data?
    var timeout: TimeInterval = 15
}

struct HTTPResponse: Sendable {
    var statusCode: Int
    var headers: [String: String]
    var body: Data

    func header(_ name: String) -> String? {
        headers[name.lowercased()]
    }
}

protocol HTTPClient: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

// NOTE: headers and successful-response bodies are NEVER logged — `Authorization`, `Cookie`, `Bearer`
// headers and token-bearing bodies would leak. The Debug line carries the method, the redacted URL, and
// the status code. On an HTTP error (>= 400) a redacted, truncated (<= 500 byte) preview of the body is
// added at Debug to aid diagnosis — never the full body, and always run through `LogRedaction.bodyPreview`
// first (which strips JWTs, api keys, and sensitive JSON values exactly like the Tauri host API did).

struct URLSessionHTTPClient: HTTPClient {
    /// One session for every provider request, built once with the optional `~/.openusage/config.json`
    /// proxy applied (see `ProxyConfig`). Default configuration — same cookie/cache semantics as
    /// `URLSession.shared` — when no valid proxy is configured.
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        if let proxy = ProxyConfig.current {
            configuration.proxyConfigurations = [proxy.proxyConfiguration()]
            // Record that a proxy is in effect (useful in a support log). Scheme/host/port only —
            // any embedded `user:pass` lives in separate fields and is never logged.
            AppLog.info(.config, "proxy enabled \(proxy.scheme.rawValue)://\(proxy.host):\(proxy.port)")
        }
        return URLSession(configuration: configuration)
    }()

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var urlRequest = URLRequest(url: request.url, timeoutInterval: request.timeout)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        for (key, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: key)
        }

        let (data, response) = try await Self.session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw HTTPClientError.invalidResponse
        }

        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            headers[String(describing: key).lowercased()] = String(describing: value)
        }

        let line = "\(request.method) \(LogRedaction.redactURL(request.url.absoluteString)) -> \(http.statusCode)"
        if http.statusCode >= 400 {
            AppLog.debug(.http, "\(line) body: \(LogRedaction.bodyPreview(String(decoding: data, as: UTF8.self)))")
        } else {
            AppLog.debug(.http, line)
        }
        return HTTPResponse(statusCode: http.statusCode, headers: headers, body: data)
    }
}

enum HTTPClientError: Error, LocalizedError {
    case invalidResponse

    var errorDescription: String? {
        "Invalid HTTP response."
    }
}

