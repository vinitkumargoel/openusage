import XCTest
@testable import OpenUsage

/// Covers the Total Spend stacked chart's data path: how `SpendActivityBuilder` buckets priced
/// events into hours and days, and how `TotalSpendChartData` windows those buckets per period,
/// ranks the legend, and sums the header total.
final class TotalSpendChartDataTests: XCTestCase {
    private let claude = Provider(id: "claude", displayName: "Claude", icon: .providerMark("claude"))
    private let cursor = Provider(id: "cursor", displayName: "Cursor", icon: .providerMark("cursor"))

    private var calendar: Calendar { Calendar.current }

    /// A fixed "now" mid-day so today/yesterday windows are unambiguous.
    private var now: Date {
        calendar.date(bySettingHour: 14, minute: 30, second: 0, of: Date(timeIntervalSince1970: 1_800_000_000))!
    }

    private func snapshot(_ provider: Provider, activity: SpendActivity?) -> ProviderSnapshot {
        ProviderSnapshot(
            providerID: provider.id,
            displayName: provider.displayName,
            lines: [],
            refreshedAt: now,
            spendActivity: activity
        )
    }

    private func hourStart(dayOffset: Int, hour: Int) -> Date {
        let day = calendar.date(byAdding: .day, value: dayOffset, to: calendar.startOfDay(for: now))!
        return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day)!
    }

    // MARK: - SpendActivityBuilder

    func testBuilderBucketsEventsIntoHoursAndDays() {
        var builder = SpendActivityBuilder()
        let tenAM = hourStart(dayOffset: 0, hour: 10)
        builder.add(timestamp: tenAM.addingTimeInterval(60), tokens: 100, costUSD: 1.0)
        builder.add(timestamp: tenAM.addingTimeInterval(1800), tokens: 50, costUSD: 0.5)
        builder.add(timestamp: hourStart(dayOffset: 0, hour: 11), tokens: 25, costUSD: 0.25)

        let activity = builder.build(estimated: true, now: now)

        XCTAssertEqual(activity?.hourly.map(\.tokens), [150, 25])
        XCTAssertEqual(activity?.hourly.first?.costUSD ?? 0, 1.5, accuracy: 0.0001)
        XCTAssertEqual(activity?.daily.count, 1)
        XCTAssertEqual(activity?.daily.first?.tokens, 175)
    }

    func testBuilderDropsHourlyBucketsOlderThanYesterdayButKeepsDaily() {
        var builder = SpendActivityBuilder()
        builder.add(timestamp: hourStart(dayOffset: -5, hour: 9), tokens: 10, costUSD: 0.1)
        builder.add(timestamp: hourStart(dayOffset: -1, hour: 9), tokens: 20, costUSD: 0.2)

        let activity = builder.build(estimated: true, now: now)

        XCTAssertEqual(activity?.hourly.map(\.tokens), [20])
        XCTAssertEqual(activity?.daily.count, 2)
    }

    func testBuilderWithNoEventsBuildsNil() {
        XCTAssertNil(SpendActivityBuilder().build(estimated: true, now: now))
    }

    // MARK: - TotalSpendChartData

    func testTodayUsesHourlyBucketsAndRanksLegendBySpend() {
        let claudeActivity = SpendActivity(
            hourly: [SpendActivityBucket(start: hourStart(dayOffset: 0, hour: 9), tokens: 100, costUSD: 2.0)],
            daily: [], estimated: true
        )
        let cursorActivity = SpendActivity(
            hourly: [
                SpendActivityBucket(start: hourStart(dayOffset: 0, hour: 9), tokens: 300, costUSD: 5.0),
                // Yesterday's hour must not leak into today's chart.
                SpendActivityBucket(start: hourStart(dayOffset: -1, hour: 9), tokens: 900, costUSD: 9.0)
            ],
            daily: [], estimated: false
        )
        let snapshots = [
            "claude": snapshot(claude, activity: claudeActivity),
            "cursor": snapshot(cursor, activity: cursorActivity)
        ]

        let data = TotalSpendChartData.build(period: .today, providers: [claude, cursor], snapshots: snapshots, now: now)

        XCTAssertEqual(data.segments.count, 2)
        XCTAssertEqual(data.providerTotals.map(\.provider.id), ["cursor", "claude"])
        XCTAssertEqual(data.totalUSD, 7.0, accuracy: 0.0001)
        XCTAssertTrue(data.isEstimated)
    }

    func testYesterdayWindowsToThatDayOnly() {
        let activity = SpendActivity(
            hourly: [
                SpendActivityBucket(start: hourStart(dayOffset: -1, hour: 22), tokens: 10, costUSD: 1.0),
                SpendActivityBucket(start: hourStart(dayOffset: 0, hour: 1), tokens: 20, costUSD: 2.0)
            ],
            daily: [], estimated: true
        )
        let snapshots = ["claude": snapshot(claude, activity: activity)]

        let data = TotalSpendChartData.build(period: .yesterday, providers: [claude], snapshots: snapshots, now: now)

        XCTAssertEqual(data.segments.map(\.tokens), [10])
    }

    func testLast30UsesDailyBucketsAndUnpricedBucketsAreExcluded() {
        let activity = SpendActivity(
            hourly: [],
            daily: [
                SpendActivityBucket(start: calendar.startOfDay(for: now), tokens: 500, costUSD: 3.0),
                // Unpriced day (unknown model): contributes nothing, matching the tiles.
                SpendActivityBucket(start: hourStart(dayOffset: -2, hour: 0), tokens: 800, costUSD: nil)
            ],
            estimated: true
        )
        let snapshots = ["claude": snapshot(claude, activity: activity)]

        let data = TotalSpendChartData.build(period: .last30, providers: [claude], snapshots: snapshots, now: now)

        XCTAssertEqual(data.segments.count, 1)
        XCTAssertEqual(data.totalUSD, 3.0, accuracy: 0.0001)
    }

    func testSnapshotWithoutActivityIsSkipped() {
        let snapshots = ["claude": snapshot(claude, activity: nil)]
        let data = TotalSpendChartData.build(period: .today, providers: [claude], snapshots: snapshots, now: now)
        XCTAssertTrue(data.isEmpty)
    }

    func testSlotLookupReturnsRankedSegments() {
        let nine = hourStart(dayOffset: 0, hour: 9)
        let snapshots = [
            "claude": snapshot(claude, activity: SpendActivity(
                hourly: [SpendActivityBucket(start: nine, tokens: 10, costUSD: 1.0)], daily: [], estimated: true
            )),
            "cursor": snapshot(cursor, activity: SpendActivity(
                hourly: [SpendActivityBucket(start: nine, tokens: 40, costUSD: 4.0)], daily: [], estimated: false
            ))
        ]

        let data = TotalSpendChartData.build(period: .today, providers: [claude, cursor], snapshots: snapshots, now: now)
        let slot = data.slotStart(for: nine.addingTimeInterval(1200))

        XCTAssertEqual(slot, nine)
        XCTAssertEqual(data.segments(at: slot).map(\.provider.id), ["cursor", "claude"])
    }
}
