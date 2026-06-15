import SwiftUI

/// The self-measuring scroll container shared by the popover's three full-height screens
/// (dashboard, Customize, Settings). Each one fills the region the pinned footer leaves, measures
/// its content height so `DashboardView` can fit the popover to it, and keeps the native scroll edge
/// effect alive while hiding the scrollbar.
///
/// The scroll edge effect (the blur as content passes under the `safeAreaBar`) needs the scroll view
/// to keep a vertical scroller, so indicators are not hidden the SwiftUI way (that removes the
/// scroller and kills the effect). `invisibleOverlayScroller()` instead keeps the overlay scroller
/// (which reserves no gutter) and just makes it invisible: effect intact, no visible bar.
///
/// `onMeasure` fires on every content-height change; the caller owns what to write and any guards
/// (e.g. ignore zero, skip while reordering, or set a "measured once" flag). Screen-specific
/// modifiers — scroll position, edge-effect style, `onAppear`, reorder-frame preferences — are
/// applied by the caller on the returned view, since those differ per screen.
struct MeasuredScrollScreen<Content: View>: View {
    let onMeasure: (CGFloat) -> Void
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView(.vertical) {
            content
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onMeasure($0) }
                .invisibleOverlayScroller()
        }
        .scrollBounceBehavior(.basedOnSize)
    }
}
