import Foundation

enum CcusageProvider: String, Sendable {
    case claude
    case codex
}

struct CcusageDay: Hashable, Sendable {
    var date: String
    var totalTokens: Int
    var costUSD: Double?
}

struct CcusageDailyUsage: Hashable, Sendable {
    var daily: [CcusageDay]
}

enum CcusageRunnerError: Error, LocalizedError, Equatable {
    case noRunner
    case failed(String)
    case timedOut
    case invalidOutput

    var errorDescription: String? {
        switch self {
        case .noRunner:
            return "No package runner found for ccusage."
        case .failed(let message):
            return message.isEmpty ? "ccusage failed." : message
        case .timedOut:
            return "ccusage timed out."
        case .invalidOutput:
            return "ccusage output was invalid."
        }
    }
}

struct CcusageRunner {
    private static let packageSpec = "ccusage@20.0.2"
    private static let timeout: TimeInterval = 15

    var processRunner: ProcessRunning
    var homeDirectory: @Sendable () -> URL

    init(
        processRunner: ProcessRunning = SystemProcessRunner(),
        homeDirectory: @escaping @Sendable () -> URL = { FileManager.default.homeDirectoryForCurrentUser }
    ) {
        self.processRunner = processRunner
        self.homeDirectory = homeDirectory
    }

    /// The `--since` argument ccusage expects: `yyyyMMdd`, `daysBack` days before `date`.
    static func sinceString(daysBack: Int, from date: Date) -> String {
        let since = Calendar.current.date(byAdding: .day, value: -daysBack, to: date) ?? date
        let components = Calendar.current.dateComponents([.year, .month, .day], from: since)
        return String(format: "%04d%02d%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }

    func query(provider: CcusageProvider, since: String, homePath: String? = nil) async -> Result<CcusageDailyUsage, CcusageRunnerError> {
        guard let bunx = resolveBunx() else {
            return .failure(.noRunner)
        }

        let args = [
            "--silent",
            Self.packageSpec,
            provider.rawValue,
            "daily",
            "--json",
            "--order",
            "desc",
            "--since",
            since
        ]

        let environment = ccusageEnvironment(provider: provider, homePath: homePath)
        do {
            let result = try processRunner.run(
                executable: bunx,
                arguments: args,
                environment: environment,
                timeout: Self.timeout
            )
            guard result.succeeded else {
                return .failure(.failed(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)))
            }
            guard let usage = Self.parseOutput(result.stdout) else {
                return .failure(.invalidOutput)
            }
            return .success(usage)
        } catch ProcessRunnerError.timedOut {
            return .failure(.timedOut)
        } catch {
            return .failure(.failed(error.localizedDescription))
        }
    }

    func resolveBunx() -> String? {
        let home = homeDirectory()
        let candidates = [
            home.appendingPathComponent(".bun/bin/bunx").path,
            "/opt/homebrew/bin/bunx",
            "/usr/local/bin/bunx",
            "bunx"
        ]

        for candidate in candidates {
            if candidate.hasPrefix("/") {
                guard FileManager.default.isExecutableFile(atPath: candidate) else { continue }
                return candidate
            }
            if commandExists(candidate) {
                return candidate
            }
        }
        return nil
    }

    private func commandExists(_ command: String) -> Bool {
        do {
            let result = try processRunner.run(
                executable: command,
                arguments: ["--version"],
                environment: enrichedPathEnvironment(),
                timeout: 2
            )
            return result.succeeded
        } catch {
            return false
        }
    }

    private func ccusageEnvironment(provider: CcusageProvider, homePath: String?) -> [String: String] {
        var env = enrichedPathEnvironment()
        if provider == .codex, let homePath, !homePath.isEmpty {
            env["CODEX_HOME"] = expandHome(homePath)
        }
        if provider == .claude, let homePath, !homePath.isEmpty {
            env["CLAUDE_CONFIG_DIR"] = expandHome(homePath)
        }
        return env
    }

    private func enrichedPathEnvironment() -> [String: String] {
        let home = homeDirectory()
        let existing = ProcessInfo.processInfo.environment["PATH"] ?? ""
        let entries = [
            home.appendingPathComponent(".bun/bin").path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            existing
        ].filter { !$0.isEmpty }
        return ["PATH": entries.joined(separator: ":")]
    }

    static func parseOutput(_ stdout: String) -> CcusageDailyUsage? {
        guard let jsonText = extractLastJSONValue(stdout),
              let data = jsonText.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data)
        else {
            return nil
        }

        let dailyRaw: [Any]
        if let array = raw as? [Any] {
            dailyRaw = array
        } else if let object = raw as? [String: Any],
                  let daily = object["daily"] as? [Any] {
            dailyRaw = daily
        } else {
            return nil
        }

        let days = dailyRaw.compactMap { entry -> CcusageDay? in
            guard let object = entry as? [String: Any],
                  let date = object["date"] as? String
            else {
                return nil
            }
            let totalTokens = readInt(object["totalTokens"]) ?? 0
            let costUSD = readDouble(object["totalCost"]) ?? readDouble(object["costUSD"])
            return CcusageDay(date: date, totalTokens: totalTokens, costUSD: costUSD)
        }

        return CcusageDailyUsage(daily: days)
    }

    static func extractLastJSONValue(_ stdout: String) -> String? {
        let trimmed = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if (try? JSONSerialization.jsonObject(with: Data(trimmed.utf8))) != nil {
            return trimmed
        }

        let scalars = Array(trimmed)
        for index in scalars.indices.reversed() {
            guard scalars[index] == "{" || scalars[index] == "[" else { continue }
            let candidate = String(scalars[index...])
            if (try? JSONSerialization.jsonObject(with: Data(candidate.utf8))) != nil {
                return candidate
            }
        }
        return nil
    }

    private static func readInt(_ value: Any?) -> Int? {
        ProviderParse.number(value).map { Int($0) }
    }

    private static func readDouble(_ value: Any?) -> Double? {
        ProviderParse.number(value)
    }
}

