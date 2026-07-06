import Foundation

/// One time bucket of a provider's spend — an hour (today/yesterday views) or a day (30-day view).
/// `start` is the bucket's local calendar start; `costUSD` is `nil` when the bucket's usage couldn't
/// be priced (tokens still count).
struct SpendActivityBucket: Hashable, Sendable, Codable {
    var start: Date
    var tokens: Int
    var costUSD: Double?
}

/// A provider's spend over time at the two grains the Total Spend chart needs: hourly buckets
/// covering today + yesterday, and daily buckets covering the scanned 30-day window. Built by the
/// same scanner/mapper loops that price the spend tiles (same events, same pricing), so the chart
/// can never disagree with the tiles. Carried on `ProviderSnapshot` and cached with it.
struct SpendActivity: Hashable, Sendable, Codable {
    var hourly: [SpendActivityBucket]
    var daily: [SpendActivityBucket]
    /// Whether this provider's dollars are local estimates (log-scanned providers) or measured
    /// (Cursor's server-priced CSV).
    var estimated: Bool
}

/// Accumulates per-event spend into hourly + daily buckets alongside the scanners' existing per-day
/// aggregation. Add every priced event, then `build` once — hourly buckets outside the retention
/// window (yesterday 00:00 onward) are dropped so the snapshot cache doesn't carry a month of hours
/// nothing renders.
struct SpendActivityBuilder {
    private var tokensByHour: [Date: Int] = [:]
    private var costByHour: [Date: Double] = [:]
    private var pricedHours: Set<Date> = []
    private var tokensByDay: [Date: Int] = [:]
    private var costByDay: [Date: Double] = [:]
    private var pricedDays: Set<Date> = []

    mutating func add(timestamp: Date, tokens: Int, costUSD: Double?) {
        let calendar = Calendar.current
        let hour = calendar.dateInterval(of: .hour, for: timestamp)?.start ?? timestamp
        let day = calendar.startOfDay(for: timestamp)
        tokensByHour[hour, default: 0] += tokens
        tokensByDay[day, default: 0] += tokens
        if let costUSD {
            costByHour[hour, default: 0] += costUSD
            costByDay[day, default: 0] += costUSD
            pricedHours.insert(hour)
            pricedDays.insert(day)
        }
    }

    /// The finished activity, or `nil` when nothing was added (no usage → no chart, matching the
    /// tiles' no-fabricated-zero rule). Hourly buckets are kept from the start of yesterday
    /// (relative to `now`) — the earliest instant the Today/Yesterday hourly views can show.
    func build(estimated: Bool, now: Date) -> SpendActivity? {
        guard !tokensByDay.isEmpty else { return nil }
        let calendar = Calendar.current
        let hourlyWindowStart = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: now))
            ?? calendar.startOfDay(for: now)
        let hourly = tokensByHour.keys
            .filter { $0 >= hourlyWindowStart }
            .sorted()
            .map { hour in
                SpendActivityBucket(
                    start: hour,
                    tokens: tokensByHour[hour] ?? 0,
                    costUSD: pricedHours.contains(hour) ? costByHour[hour] : nil
                )
            }
        let daily = tokensByDay.keys.sorted().map { day in
            SpendActivityBucket(
                start: day,
                tokens: tokensByDay[day] ?? 0,
                costUSD: pricedDays.contains(day) ? costByDay[day] : nil
            )
        }
        return SpendActivity(hourly: hourly, daily: daily, estimated: estimated)
    }
}
