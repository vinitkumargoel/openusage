import Foundation

/// The four Antigravity widget IDs and metric labels, shared by `AntigravityProvider.widgetDescriptors`
/// and `AntigravityUsageMapper` so both sides of the exact-string label binding
/// (`WidgetDescriptor.metricLabel` == `MetricLine.label`, resolved in `WidgetDataStore.data(for:)`)
/// come from one place — label drift there is a silent "No data" failure.
///
/// Antigravity merged its quota pools on 2026-05-19: Gemini Pro and Flash now draw from one shared
/// pool, every non-Gemini model (Claude, GPT-OSS) shares a second, and each pool has a rolling 5-hour
/// window plus a weekly window. `geminiID` keeps its historical `antigravity.geminiPro` raw value so
/// existing users' layout state (enabled/pin/order) carries over to the merged meter with zero migration.
enum AntigravityMetric {
    static let geminiID = "antigravity.geminiPro"
    static let geminiWeeklyID = "antigravity.geminiWeekly"
    static let claudeID = "antigravity.claude"
    static let claudeWeeklyID = "antigravity.claudeWeekly"

    static let geminiLabel = "Gemini"
    static let geminiWeeklyLabel = "Gemini Weekly"
    static let claudeLabel = "Claude"
    static let claudeWeeklyLabel = "Claude Weekly"
}
