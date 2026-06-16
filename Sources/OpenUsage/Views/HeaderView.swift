import SwiftUI

/// Footer Customize + Settings round glass buttons. Each toggles its in-popover screen: the active
/// screen's button becomes a prominent checkmark "Done", clicking it returns to the dashboard, and
/// clicking the other button switches screens directly.
struct HeaderView: View {
    @Environment(LayoutStore.self) private var layout

    var body: some View {
        // Group the adjacent glass buttons so the system samples them coherently (glass cannot sample
        // other glass). The gap stays wider than the container's merge distance, so they read as two
        // distinct circles rather than blending into one pill.
        HStack(spacing: 12) {
            roundButton(
                layout.screen == .customize ? "Done" : "Customize",
                systemImage: layout.screen == .customize ? "checkmark" : "slider.horizontal.3",
                // Prominent (accent-filled) glass marks the active screen; plain glass otherwise.
                prominent: layout.screen == .customize
            ) {
                toggle(.customize)
            }
            // Plain Return (not .defaultAction, which would restyle the glass button as default).
            .keyboardShortcut(.return, modifiers: [])

            roundButton(
                layout.screen == .settings ? "Done" : "Settings",
                systemImage: layout.screen == .settings ? "checkmark" : "gearshape",
                prominent: layout.screen == .settings
            ) {
                toggle(.settings)
            }
            // The system-wide Settings key equivalent, scoped to the popover being key.
            .keyboardShortcut(",", modifiers: .command)
        }
        .glassButtonGroup(spacing: 4)
    }

    private func toggle(_ screen: PopoverScreen) {
        withAnimation(Motion.modeSwitch) {
            layout.screen = layout.screen == screen ? .dashboard : screen
        }
    }

    /// A system Liquid Glass icon button (Tahoe) at the large control size — no custom icon
    /// font or shrunken control. On macOS 15 it falls back to a bordered button (no glass).
    /// `buttonBorderShape(.circle)` keeps the circular shape while preserving
    /// the glass highlight/shadow that `clipShape` would crop. Prominent = accent-filled glass for an
    /// active toggle state. The icon-only `Label` keeps the title for accessibility; the equal frame
    /// keeps both circles the same diameter regardless of glyph width.
    private func roundButton(
        _ title: String,
        systemImage: String,
        prominent: Bool,
        action: @escaping () -> Void
    ) -> some View {
        let label = Label(title, systemImage: systemImage)
            .labelStyle(.iconOnly)
            .frame(width: 16, height: 16)

        return Button(action: action) { label }
            .glassButtonStyle(prominent: prominent)
            .buttonBorderShape(.circle)
            // The popover's only two buttons: a larger control costs nothing and gives a bigger target.
            .controlSize(.large)
            .help(title)
    }
}
