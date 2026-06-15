import Foundation

/// Shared display formatters for live usage data: the mode-aware deadline/reset phrasing
/// (`deadlineLabel`, `bareDeadline`, `resetRelativeLabel`, `resetAbsoluteLabel`), compact durations,
/// and USD currency.
enum Formatters {
    static func currency(_ amount: Double, fractionDigits: Int = 2) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.locale = Locale(identifier: "en_US")
        f.maximumFractionDigits = fractionDigits
        f.minimumFractionDigits = fractionDigits
        // The fallback must also respect the requested precision: a raw "$\(amount)" would leak the
        // double's full decimals (e.g. "$180.168"), which is exactly the rounding glitch we're fixing.
        return f.string(from: amount as NSNumber) ?? "$\(String(format: "%.\(fractionDigits)f", amount))"
    }

    /// The one mode-aware deadline phrase, shared by every "<verb> + when" label (reset countdowns,
    /// run-out projections): `.relative` → "<prefix> in 2d 6h", `.absolute` → "<prefix> today at
    /// 5:30 PM" / "<prefix> tomorrow at 9:00 AM" / "<prefix> Feb 15 at 3:45 PM" (ported from the
    /// original's `formatResetAbsoluteLabel`; time uses the locale's 12/24-hour convention). An
    /// imminent deadline (≤5 min out relative, past-due absolute) collapses to "<prefix> soon".
    static func deadlineLabel(
        _ prefix: String,
        at date: Date,
        mode: ResetDisplayMode,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> String? {
        switch mode {
        case .relative:
            let seconds = date.timeIntervalSince(now)
            if seconds <= 5 * 60 { return "\(prefix) soon" }
            guard let duration = compactDuration(seconds) else { return nil }
            return "\(prefix) in \(duration)"
        case .absolute:
            guard date.timeIntervalSince(now) > 0 else { return "\(prefix) soon" }
            let dayDiff = calendar.dateComponents(
                [.day],
                from: calendar.startOfDay(for: now),
                to: calendar.startOfDay(for: date)
            ).day ?? 0
            // The wall-clock part honors the user's Auto/12h/24h time-format setting.
            let time = TimeFormatSetting.current.shortTime(date)
            if dayDiff <= 0 { return "\(prefix) today at \(time)" }
            if dayDiff == 1 { return "\(prefix) tomorrow at \(time)" }
            let day = date.formatted(.dateTime.month(.abbreviated).day())
            return "\(prefix) \(day) at \(time)"
        }
    }

    /// The bare "when" with no verb, for spots where an icon already carries the meaning (the
    /// label line's flame warning): `.relative` → "1d 12h" / "12h 32m", `.absolute` → "Today 5:30 PM" /
    /// "Tomorrow 11:49 PM" / "Jun 16, 11:59 PM". Imminent deadlines collapse to "Soon", matching
    /// `deadlineLabel`'s thresholds.
    static func bareDeadline(
        at date: Date,
        mode: ResetDisplayMode,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> String? {
        switch mode {
        case .relative:
            let seconds = date.timeIntervalSince(now)
            if seconds <= 5 * 60 { return "Soon" }
            return compactDuration(seconds)
        case .absolute:
            guard date.timeIntervalSince(now) > 0 else { return "Soon" }
            let dayDiff = calendar.dateComponents(
                [.day],
                from: calendar.startOfDay(for: now),
                to: calendar.startOfDay(for: date)
            ).day ?? 0
            let time = TimeFormatSetting.current.shortTime(date)
            if dayDiff <= 0 { return "Today \(time)" }
            if dayDiff == 1 { return "Tomorrow \(time)" }
            let day = date.formatted(.dateTime.month(.abbreviated).day())
            return "\(day), \(time)"
        }
    }

    static func resetRelativeLabel(until resetsAt: Date, now: Date = Date()) -> String? {
        deadlineLabel("Resets", at: resetsAt, mode: .relative, now: now)
    }

    static func resetAbsoluteLabel(at resetsAt: Date, now: Date = Date(), calendar: Calendar = .current) -> String? {
        deadlineLabel("Resets", at: resetsAt, mode: .absolute, now: now, calendar: calendar)
    }

    static func compactDuration(_ seconds: TimeInterval) -> String? {
        guard seconds.isFinite, seconds > 0 else { return nil }
        let totalMinutes = max(1, Int((seconds / 60).rounded(.up)))
        let days = totalMinutes / (24 * 60)
        let hours = (totalMinutes % (24 * 60)) / 60
        let minutes = totalMinutes % 60

        if days > 0 {
            return hours > 0 ? "\(days)d \(hours)h" : "\(days)d"
        }
        if hours > 0 {
            return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h"
        }
        return "\(minutes)m"
    }
}
