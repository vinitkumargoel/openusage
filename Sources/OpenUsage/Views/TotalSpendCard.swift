import AppKit
import Charts
import SwiftUI

/// The dashboard's cross-provider Total Spend section: a capsule period switcher over a stacked bar
/// chart of spend over time — per hour for Today / Yesterday, per day for Last 30 Days — with each
/// bar stacked by provider (brand colors). The exact period total sits top-left inside the card with
/// the share control opposite it, and a color legend closes the card. Hovering a bar shows that
/// slot's per-provider cost and tokens. Data comes from the `SpendActivity` buckets each snapshot
/// carries (see `TotalSpendChartData`), the same priced events as the per-provider spend tiles.
/// Shown only when at least two providers have spend data — a one-provider "total" would just
/// repeat that provider's own rows.
struct TotalSpendCard: View {
    @Environment(LayoutStore.self) private var layout
    @Environment(WidgetDataStore.self) private var dataStore
    @Environment(\.colorScheme) private var colorScheme
    @Namespace private var pickerNamespace

    /// The selected period survives popover closes and relaunches, like the meter-style toggles.
    @AppStorage("openusage.totalSpend.period") private var periodRawValue = TotalSpendPeriod.today.rawValue
    @AppStorage(DensitySetting.key) private var density = DensitySetting.regular

    /// True briefly after a successful copy: the share arrow becomes a checkmark, then reverts.
    @State private var shareCopied = false
    /// The pending revert, kept so a rapid second click restarts the window instead of cutting the
    /// fresh checkmark short.
    @State private var shareRevertTask: Task<Void, Never>?

    private var period: TotalSpendPeriod {
        TotalSpendPeriod(rawValue: periodRawValue) ?? .today
    }

    /// Enabled providers in the user's display order — the same set and order the dashboard sections use.
    private var providers: [Provider] {
        layout.displayGroups.map(\.provider)
    }

    private var chartData: TotalSpendChartData {
        TotalSpendChartData.build(period: period, providers: providers, snapshots: dataStore.snapshots)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: density.headerToCardSpacing) {
            header
            card
        }
    }

    // MARK: - Header

    /// Section header matching the provider headers' scale.
    private var header: some View {
        HStack(spacing: 5) {
            Text("Total Spend")
                .font(.system(size: density.headerPointSize, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Spacer(minLength: 8)
        }
        .padding(.leading, 4)
        .padding(.trailing, 4)
        .padding(.vertical, 2)
    }

    // MARK: - Card

    private var card: some View {
        let data = chartData
        return VStack(spacing: 12) {
            periodPicker
            if data.isEmpty {
                emptyState
            } else {
                TotalSpendChartContent(data: data) {
                    shareButton(data: data)
                }
                // Identity-keyed on the period so a switch crossfades to the new chart instead of
                // morphing bars between unrelated time domains.
                .id(data.period)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .cardSurface()
        .animation(Motion.spring, value: periodRawValue)
        .contextMenu {
            Button("Share Screenshot") {
                ShareCardRenderer.shareTotalSpend(data: data, appearance: colorScheme, layout: layout)
            }
        }
    }

    private func shareButton(data: TotalSpendChartData) -> some View {
        Button {
            // The checkmark only appears when the PNG actually landed on the pasteboard — a failed
            // render/copy beeps (inside the renderer) and the icon stays a share arrow.
            guard ShareCardRenderer.shareTotalSpend(data: data, appearance: colorScheme, layout: layout) else { return }
            withAnimation(Motion.spring) { shareCopied = true }
            shareRevertTask?.cancel()
            shareRevertTask = Task {
                try? await Task.sleep(for: .seconds(1.4))
                guard !Task.isCancelled else { return }
                withAnimation(Motion.spring) { shareCopied = false }
            }
        } label: {
            ShareFeedbackIcon(copied: shareCopied)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 16, height: 16)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Share Total Spend Screenshot")
    }

    /// A capsule segmented switcher in the app's own design language (the footer's glass capsule
    /// controls). The selected segment is a floating pill that slides between segments via
    /// `matchedGeometryEffect`.
    private var periodPicker: some View {
        HStack(spacing: 2) {
            ForEach(TotalSpendPeriod.allCases) { candidate in
                periodSegment(candidate)
            }
        }
        .padding(3)
        .background(.quinary, in: Capsule())
        .frame(maxWidth: .infinity)
    }

    private func periodSegment(_ candidate: TotalSpendPeriod) -> some View {
        let isSelected = candidate == period
        return Button {
            periodRawValue = candidate.rawValue
        } label: {
            Text(candidate.shortLabel)
                .font(.system(size: 11, weight: isSelected ? .semibold : .medium))
                .foregroundStyle(isSelected ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .background {
            if isSelected {
                Capsule()
                    .fill(.background)
                    .shadow(color: .black.opacity(0.12), radius: 2, y: 1)
                    .matchedGeometryEffect(id: "totalSpendPeriod", in: pickerNamespace)
            }
        }
        .animation(Motion.spring, value: periodRawValue)
    }

    /// A period every provider sat out (or one the sources haven't accounted for yet) mirrors the spend
    /// tiles' "No data" rule — never a fabricated $0.00 chart.
    private var emptyState: some View {
        Text("No spend data for this period")
            .font(.system(size: density.supportingPointSize))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
    }
}

/// The chart body shared by the live card and the share-card export so the PNG can't drift from
/// what's on screen: the exact total top-left (with the accessory — the live card's share button —
/// opposite), the stacked bars, and the color legend. Hovering a bar raises a rule + panel with the
/// slot's per-provider cost and tokens (static in the export).
struct TotalSpendChartContent<Accessory: View>: View {
    let data: TotalSpendChartData
    @ViewBuilder var accessory: () -> Accessory

    @AppStorage(DensitySetting.key) private var density = DensitySetting.regular
    /// The hovered instant on the chart's time axis (macOS updates it on pointer hover).
    @State private var selection: Date?

    private static var chartHeight: CGFloat { 110 }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            totalRow
            chart
            legend
        }
    }

    // MARK: - Total

    /// The period total, exact to the cent — the user asked for the unshortened figure here; compact
    /// forms stay in the legend.
    private var totalRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(MetricFormatter.number(data.totalUSD, kind: .dollars, style: .full))
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(.primary)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if data.isEstimated {
                Image(systemName: "info.circle")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .hoverTooltip(WidgetData.localEstimateNote)
            }
            Spacer(minLength: 8)
            accessory()
        }
    }

    // MARK: - Chart

    private var chart: some View {
        Chart {
            ForEach(data.segments) { segment in
                BarMark(
                    x: .value("Time", segment.start, unit: data.bucketUnit),
                    y: .value("Spend", segment.costUSD)
                )
                .foregroundStyle(by: .value("Provider", segment.provider.displayName))
                .cornerRadius(2)
            }
            if let slot = hoveredSlot {
                RuleMark(x: .value("Time", slot, unit: data.bucketUnit))
                    .foregroundStyle(.secondary.opacity(0.35))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .annotation(
                        position: .top,
                        alignment: .center,
                        overflowResolution: .init(x: .fit(to: .chart), y: .disabled)
                    ) {
                        hoverPanel(slot: slot)
                    }
            }
        }
        .chartForegroundStyleScale(
            domain: data.providerTotals.map(\.provider.displayName),
            range: data.providerTotals.map { TotalSpendPalette.color(for: $0.provider.id) }
        )
        .chartLegend(.hidden)
        .chartXScale(domain: data.xDomain)
        .chartXAxis { xAxisMarks }
        .chartYAxis {
            AxisMarks(position: .trailing) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let dollars = value.as(Double.self) {
                        Text(MetricFormatter.number(dollars, kind: .dollars, style: .tray))
                            .font(.system(size: 8))
                    }
                }
            }
        }
        .chartXSelection(value: $selection)
        .frame(height: Self.chartHeight)
        .accessibilityLabel(accessibilityLabel)
    }

    @AxisContentBuilder
    private var xAxisMarks: some AxisContent {
        if data.period == .last30 {
            AxisMarks(values: .stride(by: .day, count: 7)) { _ in
                AxisValueLabel(format: .dateTime.month(.abbreviated).day(), collisionResolution: .greedy)
                    .font(.system(size: 8))
            }
        } else {
            AxisMarks(values: .stride(by: .hour, count: 6)) { _ in
                AxisValueLabel(format: .dateTime.hour(), collisionResolution: .greedy)
                    .font(.system(size: 8))
            }
        }
    }

    /// The hovered bucket's start, only when that bucket actually has data — hovering an idle hour
    /// raises nothing.
    private var hoveredSlot: Date? {
        guard let selection else { return nil }
        let slot = data.slotStart(for: selection)
        return data.segments(at: slot).isEmpty ? nil : slot
    }

    // MARK: - Hover panel

    private func hoverPanel(slot: Date) -> some View {
        let slices = data.segments(at: slot)
        return VStack(alignment: .leading, spacing: 3) {
            Text(slotTitle(slot))
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
            ForEach(slices) { segment in
                HStack(spacing: 5) {
                    Circle()
                        .fill(TotalSpendPalette.color(for: segment.provider.id))
                        .frame(width: 6, height: 6)
                    Text(segment.provider.displayName)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.primary)
                    Spacer(minLength: 10)
                    Text(segmentReadout(segment))
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(.separator, lineWidth: 0.5)
        }
    }

    private func segmentReadout(_ segment: TotalSpendChartData.Segment) -> String {
        let cost = MetricFormatter.number(segment.costUSD, kind: .dollars, style: .row)
        let tokens = MetricFormatter.number(Double(segment.tokens), kind: .count, style: .row)
        return "\(cost) · \(tokens) tokens"
    }

    private func slotTitle(_ slot: Date) -> String {
        if data.period == .last30 {
            return Formatters.monthDayLabel(slot)
        }
        let end = Calendar.current.date(byAdding: .hour, value: 1, to: slot) ?? slot
        let formatter = Date.FormatStyle(date: .omitted, time: .shortened)
        return "\(slot.formatted(formatter)) – \(end.formatted(formatter))"
    }

    // MARK: - Legend

    /// Ranked color legend (largest spender first) with each provider's compact period total; exact
    /// figures live on the bars' hover.
    private var legend: some View {
        HStack(spacing: 14) {
            ForEach(data.providerTotals) { total in
                HStack(spacing: 5) {
                    Circle()
                        .fill(TotalSpendPalette.color(for: total.provider.id))
                        .frame(width: 7, height: 7)
                    Text(total.provider.displayName)
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(MetricFormatter.number(total.costUSD, kind: .dollars, style: .tray))
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var accessibilityLabel: String {
        let total = MetricFormatter.number(data.totalUSD, kind: .dollars, style: .full)
        return "Total spend \(total) across \(data.providerTotals.count) providers, \(data.period.rawValue)"
    }
}

/// Stable per-provider brand tints for the Total Spend chart and legend — the one place the app maps
/// a provider to a color, so the chart, legend, and share card always agree. Colors are keyed by
/// provider ID only (never by rank or position), so a provider keeps its color across period
/// switches, re-sorts, and launches. Hexes come from the legacy edition's per-plugin `brandColor`
/// values; brands whose color is plain black (Cursor, Grok) get adaptive near-black/near-white
/// dynamic colors so they read on both appearances without both landing on the same gray.
enum TotalSpendPalette {
    private static let byProviderID: [String: Color] = [
        "claude": hex(0xDE7356),                             // Claude terracotta
        "codex": hex(0x74AA9C),                              // OpenAI green
        "cursor": dynamic(light: 0x1D1D1F, dark: 0xF5F5F7),  // brand black, adaptive
        "grok": dynamic(light: 0x8E8E93, dark: 0x98989D),    // brand black, offset to gray next to Cursor
        "openrouter": hex(0x6467F2),                         // OpenRouter indigo
        "antigravity": hex(0x4285F4),                        // Google blue
        "copilot": hex(0xA855F7),                            // Copilot purple
        "amp": hex(0xF34E3F),
        "factory": dynamic(light: 0x48484A, dark: 0xC7C7CC),
        "kimi": hex(0x0A66FF),
        "minimax": hex(0xF5433C),
        "zai": dynamic(light: 0x2D2D2D, dark: 0xD1D1D6)
    ]

    /// Deterministic backstop hues for a provider that ships without a palette entry — keyed off the
    /// provider ID (not rank), so the color holds steady across periods and launches.
    private static let fallback: [Color] = [
        hex(0x34C759), hex(0x5856D6), hex(0xFF2D55), hex(0xA2845E)
    ]

    static func color(for providerID: String) -> Color {
        if let brand = byProviderID[providerID] { return brand }
        let stableHash = providerID.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return fallback[stableHash % fallback.count]
    }

    private static func hex(_ value: UInt32) -> Color {
        Color(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }

    /// A light/dark-adaptive color, for brands whose mark is pure black — invisible on a dark card
    /// unless flipped.
    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(
                red: CGFloat((value >> 16) & 0xFF) / 255,
                green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255,
                alpha: 1
            )
        })
    }
}
