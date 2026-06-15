import Foundation

struct ProviderSnapshotCache {
    private struct Payload: Codable {
        var snapshots: [String: ProviderSnapshot]
    }

    private let userDefaults: UserDefaults
    private let storageKey: String
    /// TTL is dynamic so it can track the user's chosen refresh interval. A snapshot stays fresh for
    /// exactly one interval, which (read from the same `UserDefaults`) is what lets cached data survive
    /// a relaunch without an immediate refetch and expire precisely when the next refresh is due.
    private let ttlProvider: () -> TimeInterval
    private let now: () -> Date
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(
        userDefaults: UserDefaults = .standard,
        storageKey: String = "openusage.providerSnapshots.v2",
        ttlProvider: (() -> TimeInterval)? = nil,
        now: @escaping () -> Date = Date.init
    ) {
        self.userDefaults = userDefaults
        self.storageKey = storageKey
        self.ttlProvider = ttlProvider ?? { RefreshSetting.interval(from: userDefaults) }
        self.now = now
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        self.encoder = encoder
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder
    }

    /// Fixed-TTL convenience used by tests that want a deterministic freshness window.
    init(
        userDefaults: UserDefaults = .standard,
        storageKey: String = "openusage.providerSnapshots.v2",
        ttl: TimeInterval,
        now: @escaping () -> Date = Date.init
    ) {
        self.init(
            userDefaults: userDefaults,
            storageKey: storageKey,
            ttlProvider: { ttl },
            now: now
        )
    }

    /// Every stored snapshot for the given providers, including expired ones. Display uses this
    /// (stale-while-revalidate: last-known values keep showing while a refresh runs); refresh gating
    /// still goes through the TTL-checked `snapshot(providerID:)`.
    func loadSnapshots(providerIDs: [String]) -> [String: ProviderSnapshot] {
        let providerIDSet = Set(providerIDs)
        return loadPayload().snapshots.filter { providerID, _ in
            providerIDSet.contains(providerID)
        }
    }

    func snapshot(providerID: String) -> ProviderSnapshot? {
        let snapshot = loadPayload().snapshots[providerID]
        guard let snapshot, isValid(snapshot) else { return nil }
        return snapshot
    }

    func store(_ snapshot: ProviderSnapshot) {
        guard !snapshot.lines.contains(where: \.isError) else { return }
        var payload = loadPayload()
        payload.snapshots[snapshot.providerID] = snapshot
        save(payload)
    }

    private func isValid(_ snapshot: ProviderSnapshot) -> Bool {
        now().timeIntervalSince(snapshot.refreshedAt) < ttlProvider()
    }

    private func loadPayload() -> Payload {
        guard let data = userDefaults.data(forKey: storageKey),
              let payload = try? decoder.decode(Payload.self, from: data)
        else {
            return Payload(snapshots: [:])
        }
        return payload
    }

    private func save(_ payload: Payload) {
        guard let data = try? encoder.encode(payload) else { return }
        userDefaults.set(data, forKey: storageKey)
    }
}

