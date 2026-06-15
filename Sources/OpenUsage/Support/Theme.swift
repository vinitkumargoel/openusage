import SwiftUI
import AppKit

/// Central palette + surface styles. Surfaces stay adaptive (light/dark).
enum Theme {
    /// Hierarchical secondary tint for the provider marks — the vibrancy-correct gray on glass.
    static let iconGray = AnyShapeStyle(.secondary)

    /// Meter fill for a severity band — the macOS system palette (the battery-style traffic
    /// light), never hand-tuned hexes, so the bars track light/dark and accessibility settings
    /// like every other system meter. Softened through `glassTint`: explicit colors get no
    /// vibrancy adaptation on the popover glass, so full-strength fills glow against the
    /// tempered material around them.
    static func meterFill(_ severity: WidgetData.MeterSeverity) -> AnyShapeStyle {
        glassTint(meterColor(severity))
    }

    private static func meterColor(_ severity: WidgetData.MeterSeverity) -> Color {
        switch severity {
        case .normal: return Color(nsColor: .systemBlue)
        case .warning: return Color(nsColor: .systemYellow)
        case .critical: return Color(nsColor: .systemRed)
        }
    }

    /// How much of the saturated color survives the glass softening (1 = full strength).
    static let glassTintStrength = 0.8

    /// Wraps a saturated color for use on the popover glass: blended toward a per-scheme neutral
    /// so the material tempers it the way vibrancy tempers semantic styles. Increase Contrast
    /// bypasses the fade (Apple: every custom color on glass needs an increased-contrast variant).
    static func glassTint(_ color: Color, strength: Double = glassTintStrength) -> AnyShapeStyle {
        AnyShapeStyle(GlassTint(color: color, strength: strength))
    }

    /// Inline notice/alert tint (refresh warning triangle, pin-limit notice, settings errors) —
    /// the system orange softened for glass like the meter fills.
    static let notice = glassTint(Color(nsColor: .systemOrange))

    /// Card surface for the metric groups: a semantic quaternary fill over the system popover glass
    /// (the Control Center module look). Semantic — not a hand-tuned solid — so the cards track
    /// light/dark, Increase Contrast, Reduce Transparency, and the OS Liquid Glass transparency
    /// setting automatically.
    static let cardFill = AnyShapeStyle(.quaternary)

    /// Backing for lifted drag previews: material, so the floating card stays legible over the rows
    /// it passes instead of letting them bleed through a translucent fill.
    static let liftedCardFill = AnyShapeStyle(Material.regular)

    /// The single corner radius for every metric/settings card surface and its lifted twin, so the
    /// floating drag preview always matches the live card's shape.
    static let cardCornerRadius: CGFloat = 12

    /// The rounded rectangle shared by every card surface (live and lifted), so the shape is defined once.
    static var cardShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cardCornerRadius, style: .continuous)
    }
}

extension View {
    /// The grouped-card surface used for provider/settings cards: the semantic quaternary fill in
    /// the shared rounded shape. Pass `lifted: true` for the floating drag preview, which swaps the
    /// fill for the legible material so the card reads over (not through) the rows it passes.
    /// Routing every card site through this keeps the live card and its lifted twin one shape.
    func cardSurface(lifted: Bool = false) -> some View {
        background(lifted ? Theme.liftedCardFill : Theme.cardFill, in: Theme.cardShape)
    }

    /// A single-row lifted preview surface: the card fill plus the thin separator hairline that
    /// fences a free-floating one-row chip off from the rows beneath it (the multi-row provider
    /// previews don't take the hairline — the card outline alone reads as detached there).
    func liftedRowSurface() -> some View {
        cardSurface(lifted: true)
            .overlay { Theme.cardShape.strokeBorder(.separator, lineWidth: 0.5) }
    }

    /// The trailing on/off switch styling shared by every settings + Customize row toggle: no inline
    /// label (the row's leading text is the label), the native switch style, small control size.
    func settingsSwitchStyle() -> some View {
        labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.small)
    }
}

/// Saturated tint softened for Liquid Glass; Increase Contrast resolves to the full-strength
/// color (whose system-color base also swaps to its high-contrast variant through the
/// appearance). The blend is opaque rather than alpha-faded on purpose: a translucent fill
/// picks up whatever sits beneath it (the meter fill sits on the quaternary track, the flame
/// glyph on the card), so the "same" color would read differently per backdrop. Mixing toward
/// a fixed per-scheme neutral keeps every use of one severity color identical.
private struct GlassTint: ShapeStyle {
    var color: Color
    var strength: Double

    func resolve(in environment: EnvironmentValues) -> Color {
        guard environment.colorSchemeContrast != .increased else { return color }
        let neutral = environment.colorScheme == .dark ? Color(white: 0.16) : Color(white: 0.94)
        return color.mix(with: neutral, by: 1 - strength)
    }
}
