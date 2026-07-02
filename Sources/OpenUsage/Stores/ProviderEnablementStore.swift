import Foundation
import Observation

/// The single source of truth for which providers are turned on.
///
/// Two storage modes, distinguished by which key exists:
/// - **Legacy disabled-list** (`openusage.disabledProviders.v1`): only the *disabled* IDs are persisted.
///   "Everything on" is an empty set, so a provider shipped in a future release defaults to enabled.
///   Every install that predates minimal defaults stays in this mode forever — their world started
///   all-on, and new providers keep appearing automatically, as they always have.
/// - **Enabled-list** (`openusage.enabledProviders.v1`): only the *enabled* IDs are persisted. Fresh
///   installs are seeded into this mode (see `FirstRunSeeder`) with just the providers detected on the
///   machine, so a provider shipped in a future release defaults to OFF — consistent with the minimal
///   world those users started in.
///
/// When the enabled-list key exists it wins; the legacy key is ignored.
@MainActor
@Observable
final class ProviderEnablementStore {
    private static let disabledStorageKey = "openusage.disabledProviders.v1"
    private static let enabledStorageKey = "openusage.enabledProviders.v1"

    /// Posted when the enabled-provider set actually changes. The refresh loop listens for this to wake
    /// early and fetch a newly-enabled provider promptly, instead of waiting out the full interval —
    /// WITHOUT subscribing to the firehose `UserDefaults.didChangeNotification`, which also fires for the
    /// app's own snapshot-cache writes, Sparkle's update bookkeeping, and unrelated global-domain changes
    /// from other processes. Waking on that (with no minimum interval) collapsed the fixed 5-minute
    /// cadence into a refresh storm.
    ///
    /// `nonisolated` so the refresh loop's background task can name it without hopping to the main actor
    /// (it's an immutable, `Sendable` constant — like Foundation's own notification names).
    nonisolated static let didChangeNotification = Notification.Name("ProviderEnablementDidChange")

    /// Called with a provider's id the moment it turns ON (not on disable, not on a no-op re-set).
    /// `AppContainer` wires this to clear that provider's failure backoff, so the enablement wake's
    /// refresh actually probes it instead of being suppressed by a backoff left over from a failure
    /// just before it was turned off.
    var onProviderEnabled: (@MainActor (String) -> Void)?

    /// Legacy-mode state: the providers the user turned off. Unused (empty) in enabled-list mode.
    private(set) var disabledIDs: Set<String>
    /// Enabled-list-mode state; `nil` means legacy disabled-list mode.
    private(set) var enabledIDs: Set<String>?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let enabled = defaults.stringArray(forKey: Self.enabledStorageKey) {
            self.enabledIDs = Set(enabled)
            self.disabledIDs = []
        } else {
            self.enabledIDs = nil
            self.disabledIDs = Set(defaults.stringArray(forKey: Self.disabledStorageKey) ?? [])
        }
    }

    func isEnabled(_ id: String) -> Bool {
        if let enabledIDs { return enabledIDs.contains(id) }
        return !disabledIDs.contains(id)
    }

    func setEnabled(_ enabled: Bool, for id: String) {
        if var ids = enabledIDs {
            if enabled { ids.insert(id) } else { ids.remove(id) }
            // A no-op toggle (re-setting the same value) shouldn't persist or wake the refresh loop.
            guard ids != enabledIDs else { return }
            enabledIDs = ids
            defaults.set(Array(ids), forKey: Self.enabledStorageKey)
        } else {
            let before = disabledIDs
            if enabled {
                disabledIDs.remove(id)
            } else {
                disabledIDs.insert(id)
            }
            guard disabledIDs != before else { return }
            defaults.set(Array(disabledIDs), forKey: Self.disabledStorageKey)
        }
        // Clear the backoff BEFORE the wake notification, so the refresh it triggers actually probes the
        // just-enabled provider instead of skipping it as recently-failed.
        if enabled { onProviderEnabled?(id) }
        NotificationCenter.default.post(name: Self.didChangeNotification, object: nil)
    }

    /// Switches the store into enabled-list mode with exactly `ids` on. Used by `FirstRunSeeder` on
    /// fresh installs only — first synchronously with the fallback set, then again with the detected
    /// set. Fires `onProviderEnabled` for each newly-on provider and posts the change notification, so
    /// the refresh loop fetches them promptly.
    func seedEnabledProviders(_ ids: Set<String>) {
        let newlyEnabled = ids.filter { !isEnabled($0) }
        let changed = enabledIDs != ids
        enabledIDs = ids
        disabledIDs = []
        defaults.set(Array(ids), forKey: Self.enabledStorageKey)
        guard changed else { return }
        for id in newlyEnabled.sorted() { onProviderEnabled?(id) }
        NotificationCenter.default.post(name: Self.didChangeNotification, object: nil)
    }
}
