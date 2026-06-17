import AppKit
import SwiftUI

/// Bridges a SwiftUI glass button to a native `NSMenu` pull-down. A SwiftUI `Menu` styled as a button
/// won't match the footer's round glass buttons — `.menuStyle(.button)` reserves its own indicator
/// chrome and shape — so instead the footer keeps its exact `roundButton` (the proven glass control)
/// and pops a real `NSMenu` anchored to it. Only the menu presentation crosses into AppKit; the button
/// itself stays pure SwiftUI.
///
/// Popping a real `NSMenu` also plays nicely with the popover, which already keeps itself open when an
/// `NSMenu`-backed window appears (see `StatusItemController.shouldKeepPopoverOpen`).

/// Holds the hosted anchor view so the button's action can pop a menu positioned under it. `@State`
/// keeps one instance stable across re-renders; the view reference is weak so it never outlives layout.
@MainActor
final class PopUpMenuAnchor {
    weak var view: NSView?

    /// Drops `menu` from the anchor's bottom-leading corner. SwiftUI hosts representables in flipped
    /// views, so `bounds.maxY` is the button's bottom edge — the menu opens downward from there, and
    /// macOS flips it upward automatically near the screen edge.
    func present(_ menu: NSMenu) {
        guard let view else { return }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: view.bounds.maxY + 4), in: view)
    }
}

/// A zero-cost background view that captures its hosted `NSView` into the shared anchor. Placed via
/// `.background(...)`, it fills the button's frame, so the captured view's bounds match the button.
struct PopUpMenuAnchorView: NSViewRepresentable {
    let anchor: PopUpMenuAnchor

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        anchor.view = view
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        anchor.view = nsView
    }
}

/// An `NSMenuItem` that runs a closure when selected, so menus can be built inline without a separate
/// target/action object. `keyEquivalent` defaults to none; when set it uses the ⌘ modifier (the
/// standard for menu shortcuts like ⌘Q).
@MainActor
final class ClosureMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(title: String, systemSymbol: String? = nil, keyEquivalent: String = "", handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(fire), keyEquivalent: keyEquivalent)
        target = self
        if let systemSymbol {
            image = NSImage(systemSymbolName: systemSymbol, accessibilityDescription: nil)
        }
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    @objc private func fire() {
        handler()
    }
}
