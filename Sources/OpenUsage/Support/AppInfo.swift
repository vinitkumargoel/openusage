import Foundation

/// Single source of truth for the app's marketing version, shown in the dashboard footer and the
/// About settings tab. The value is baked into the bundle by `script/build_and_run.sh` (dev) and
/// `script/release.sh` (release); the fallback covers runs outside the packaged app (e.g. `swift run`,
/// where there is no Info.plist).
///
/// Prefer `OUMarketingVersion`: it carries the full tag version including any pre-release suffix
/// (e.g. `0.7.0-beta.2`), which the user-facing version should display. `CFBundleShortVersionString`
/// is kept numeric for Sparkle/Gatekeeper, so it is only the fallback.
enum AppInfo {
    static var version: String {
        let info = Bundle.main.infoDictionary
        if let full = info?["OUMarketingVersion"] as? String, !full.isEmpty {
            return full
        }
        return (info?["CFBundleShortVersionString"] as? String) ?? "0.7.0"
    }
}
