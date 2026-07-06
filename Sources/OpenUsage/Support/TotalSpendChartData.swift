import Foundation

/// The Total Spend stacked-bar chart's data for one period: per-provider spend segments in time
/// buckets (hours for Today/Yesterday, days for Last 30 Days), plus ranked per-provider totals for
/// the legend and the header sum. Built purely from the `SpendActivity` each spend-tracking
/// provider's snapshot carries — the same priced events as its spend tiles — so the chart, tiles,
/// and legend can never disagree about a provider's numbers.
struct TotalSpendChartData {
    /// One provider's spend inside one time bucket — one stacked layer of one bar.
    struct Segment: Identifiable {
        let provider: Provider
        let start: Date
        let costUSD: Double
        let tokens: Int

        var id: String { "\(provider.id)-\(start.timeIntervalSinceReferenceDate)" }
    }

    /// One provider's whole-period total — one legend row, ranked largest-first.
    struct ProviderTotal: Identifiable {
        let provider: Provider
        let costUSD: Double
        let tokens: Int
        let estimated: Bool

        var id: String { provider.id }
    }

    let period: TotalSpendPeriod
    /// The chart's fixed x-range: the full day (or 31-day window), not just the buckets with data —
    /// today's chart keeps its future hours empty on the right instead of stretching noon to the edge.
    let xDomain: ClosedRange<Date>
    let segments: [Segment]
    let providerTotals: [ProviderTotal]

    var totalUSD: Double { providerTotals.reduce(0) { $0 + $1.costUSD } }
    var isEstimated: Bool { providerTotals.contains(where: \.estimated) }
    var isEmpty: Bool { segments.isEmpty }

    /// The calendar grain of one bucket, matching how `SpendActivityBuilder` bucketed the events.
    var bucketUnit: Calendar.Component { period == .last30 ? .day : .hour }

    static func build(
        period: TotalSpendPeriod,
        providers: [Provider],
        snapshots: [String: ProviderSnapshot],
        now: Date = Date()
    ) -> TotalSpendChartData {
        let calendar = Calendar.current
        let startOfToday = calendar.startOfDay(for: now)
        let startOfTomorrow = calendar.date(byAdding: .day, value: 1, to: startOfToday) ?? startOfToday
        let xDomain: ClosedRange<Date>
        switch period {
        case .today:
            xDomain = startOfToday...startOfTomorrow
        case .yesterday:
            let start = calendar.date(byAdding: .day, value: -1, to: startOfToday) ?? startOfToday
            xDomain = start...startOfToday
        case .last30:
            // 31 calendar days including today — the same window the scanners query and the Usage
            // Trend sparkline draws.
            let start = calendar.date(byAdding: .day, value: -30, to: startOfToday) ?? startOfToday
            xDomain = start...startOfTomorrow
        }

        var segments: [Segment] = []
        var costByProvider: [String: Double] = [:]
        var tokensByProvider: [String: Int] = [:]
        var estimatedProviderIDs: Set<String> = []

        for provider in providers {
            guard let activity = snapshots[provider.id]?.spendActivity else { continue }
            let buckets = period == .last30 ? activity.daily : activity.hourly
            for bucket in buckets where xDomain.contains(bucket.start) && bucket.start < xDomain.upperBound {
                // Unpriced buckets (unknown models) contribute nothing, matching the tiles'
                // exclusion rule; a zero-cost, zero-token bucket is idle noise.
                guard let cost = bucket.costUSD, cost > 0 || bucket.tokens > 0 else { continue }
                segments.append(Segment(provider: provider, start: bucket.start, costUSD: cost, tokens: bucket.tokens))
                costByProvider[provider.id, default: 0] += cost
                tokensByProvider[provider.id, default: 0] += bucket.tokens
                if activity.estimated { estimatedProviderIDs.insert(provider.id) }
            }
        }

        let ranked = providers
            .compactMap { provider -> ProviderTotal? in
                guard let cost = costByProvider[provider.id] else { return nil }
                return ProviderTotal(
                    provider: provider,
                    costUSD: cost,
                    tokens: tokensByProvider[provider.id] ?? 0,
                    estimated: estimatedProviderIDs.contains(provider.id)
                )
            }
            .sorted { lhs, rhs in
                if lhs.costUSD != rhs.costUSD { return lhs.costUSD > rhs.costUSD }
                return lhs.provider.displayName.localizedStandardCompare(rhs.provider.displayName) == .orderedAscending
            }

        return TotalSpendChartData(period: period, xDomain: xDomain, segments: segments, providerTotals: ranked)
    }

    /// The bucket start a hover selection falls into — hourly or daily to match the bars.
    func slotStart(for date: Date) -> Date {
        let calendar = Calendar.current
        if period == .last30 { return calendar.startOfDay(for: date) }
        return calendar.dateInterval(of: .hour, for: date)?.start ?? date
    }

    /// One slot's stacked layers, largest first — the hover panel's rows.
    func segments(at slotStart: Date) -> [Segment] {
        segments
            .filter { $0.start == slotStart }
            .sorted { $0.costUSD > $1.costUSD }
    }
}
