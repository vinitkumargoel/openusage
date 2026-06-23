import Foundation

/// A provider-neutral per-day token/cost series — the shared carrier every spend-tracking provider
/// funnels through `SpendTileMapper` (the Today / Yesterday / Last 30 Days tiles and the Usage Trend
/// chart).
///
/// Sources build it from very different inputs and hand `SpendTileMapper` the same shape so the tiles
/// render identically regardless of origin: Claude/Codex from `ccusage` output (`CcusageRunner`),
/// Cursor from its usage CSV export, Grok from its CLI log. The name is deliberately neutral — only
/// the Claude/Codex path actually involves the ccusage package.
///
/// These are internal types with no serialization impact: the local HTTP API serializes `MetricLine`,
/// not these.
struct DailyUsageEntry: Hashable, Sendable {
    var date: String
    var totalTokens: Int
    var costUSD: Double?
}

struct DailyUsageSeries: Hashable, Sendable {
    var daily: [DailyUsageEntry]
}
