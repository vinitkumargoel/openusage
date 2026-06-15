import AppKit
import SwiftUI

@main
struct OpenUsageApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // Menu-bar app: the status item and popover are AppKit-owned (see StatusItemController),
        // so no window scene is wanted. `Settings` gives SwiftUI a valid scene without creating
        // an activation window.
        Settings {
            EmptyView()
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var container: AppContainer?
    private var statusItemController: StatusItemController?
    private let updater = UpdaterController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Open/trim the file log, seed the cached level, and emit the startup line BEFORE anything
        // else logs, so the first lines of a session are captured.
        AppLog.bootstrap()
        // App-wide theme override (NSApp.appearance): the popover ignores SwiftUI's
        // preferredColorScheme, so the override is applied at the AppKit level once at launch;
        // the Theme picker on the Settings screen re-applies it on change.
        AppearanceSetting.applyCurrent()
        let container = AppContainer()
        self.container = container
        statusItemController = StatusItemController(container: container, updater: updater)
        // Starts background update checks (release build only; dormant under preview/`swift run`).
        updater.start()
    }
}
