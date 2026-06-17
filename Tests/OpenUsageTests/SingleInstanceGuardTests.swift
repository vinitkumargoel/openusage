import XCTest
@testable import OpenUsage

/// Covers the single-instance guard's decision logic (issue #635): given our PID and the PIDs of
/// running apps sharing our bundle id, decide whether *this* launch is the duplicate that should bow
/// out. The live `NSRunningApplication` query and the activate/terminate handoff are thin glue over
/// this pure function and aren't unit-testable (they need a second running process).
@MainActor
final class SingleInstanceGuardTests: XCTestCase {
    func testSoloLaunchIsNotADuplicate() {
        // Only our own process is running — nothing to defer to.
        XCTAssertFalse(SingleInstanceGuard.isDuplicate(myPID: 42, runningPIDs: [42]))
    }

    func testNoRunningAppsIsNotADuplicate() {
        // Defensive: an empty workspace result must never read as a duplicate.
        XCTAssertFalse(SingleInstanceGuard.isDuplicate(myPID: 42, runningPIDs: []))
    }

    func testAnotherInstanceIsADuplicate() {
        // A second copy (pid 7) already owns the slot — we're the duplicate.
        XCTAssertTrue(SingleInstanceGuard.isDuplicate(myPID: 42, runningPIDs: [7, 42]))
    }

    func testOurOwnPIDIsIgnoredAmongOthers() {
        // Our PID appears in the list (we're registered too); it must be filtered out, and the other
        // PID (99) must still mark us as the duplicate.
        XCTAssertTrue(SingleInstanceGuard.isDuplicate(myPID: 42, runningPIDs: [42, 99]))
    }
}
