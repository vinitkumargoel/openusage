import AppKit

/// Rejects a second copy of OpenUsage at launch (issue #635). macOS can fire two independent launch
/// triggers on reboot — session restoration ("Reopen windows when logging back in") and the
/// `SMAppService` login item — and a crashed or hung copy can linger holding `127.0.0.1:6736`.
/// Without a guard either path yields a duplicate menu-bar icon (or, for an `LSUIElement` app, a
/// launch that "does nothing"). The decision is split out from the live-workspace query so it can be
/// unit-tested without a second running process.
@MainActor
enum SingleInstanceGuard {
    /// Pure decision: another copy already owns the slot when some running PID sharing our bundle id
    /// isn't our own. Our own PID is filtered out so a solo launch never counts itself.
    static func isDuplicate(myPID: pid_t, runningPIDs: [pid_t]) -> Bool {
        runningPIDs.contains { $0 != myPID }
    }

    /// Live check + handoff. When an existing instance owns the slot, hands focus to it and returns
    /// `true` so the caller bows out before grabbing the local-API port or adding a status item.
    /// Returns `false` (no-op) when we are the only copy, or when unbundled (`swift run`/preview) has
    /// no bundle identifier to match against.
    static func deferToExistingInstance() -> Bool {
        guard let bundleID = Bundle.main.bundleIdentifier else { return false }
        let me = NSRunningApplication.current
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        guard isDuplicate(myPID: me.processIdentifier, runningPIDs: running.map(\.processIdentifier)) else {
            return false
        }
        running.first { $0.processIdentifier != me.processIdentifier }?.activate()
        return true
    }
}
