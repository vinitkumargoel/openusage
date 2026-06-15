import SwiftUI

/// The Customize metric row shape, shared by the live row in `CustomizeView` and the lifted drag
/// preview in `ReorderLiftPreview`. Defining the grip + label + trailing layout (and its
/// density-derived padding) once is what keeps the floating preview pixel-identical to the row the
/// user is dragging — the two used to be hand-rebuilt separately and drifted apart.
///
/// The leading grip + label form the drag *handle* (the live row attaches its reorder gesture to
/// just that region, leaving the trailing pin + toggle normally tappable); the trailing slot is
/// supplied by the caller — the live row passes its real pin button + `Toggle`, the preview a
/// static switch placeholder.
struct CustomizeMetricRow<Handle: View, Trailing: View>: View {
    let title: String
    /// Wraps the leading grip + label + spacer (the drag-handle region). The live row threads its
    /// `contentShape` + reorder gesture through here; the preview leaves it untouched.
    let handle: (AnyView) -> Handle
    @ViewBuilder var trailing: Trailing

    @AppStorage(DensitySetting.key) private var density = DensitySetting.regular

    var body: some View {
        HStack(spacing: 10) {
            handle(
                AnyView(
                    HStack(spacing: 10) {
                        ReorderGrip()
                        Text(title)
                            .foregroundStyle(.primary)
                        Spacer(minLength: 8)
                    }
                )
            )
            trailing
        }
        .padding(.horizontal, 12)
        .padding(.vertical, density.controlRowPadding)
    }
}

extension CustomizeMetricRow where Handle == AnyView {
    /// Static variant for the lifted drag preview: the handle region is rendered inert (no gesture).
    init(title: String, @ViewBuilder trailing: () -> Trailing) {
        self.init(title: title, handle: { $0 }, trailing: trailing)
    }
}

/// The static switch placeholder the lifted previews render where the live row shows a real
/// `Toggle` — a quaternary capsule the size of a small switch, so the floating chip reads like the
/// row without carrying a live control.
struct CustomizeSwitchPlaceholder: View {
    var body: some View {
        Capsule()
            .fill(.quaternary)
            .frame(width: 28, height: 16)
    }
}
