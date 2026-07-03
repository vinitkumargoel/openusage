import SwiftUI

/// The one-time first-run hint card at the top of the dashboard. Fresh installs start with only the
/// providers detected on the machine (see `FirstRunSeeder`), so this card tells the user why the list
/// is short and where to change it. It appears only while `OnboardingStore.isCustomizeHintPending` is
/// set — marked by the seeder on a fresh install, so existing installs never see it — and goes away
/// for good only on its close button. Visiting Customize deliberately does NOT dismiss it: a quick
/// look around shouldn't cost a new user the pointer.
///
/// A grouped content card (`cardSurface`), not chrome: it scrolls with the provider sections and uses
/// the same surface they do.
struct CustomizeHintCard: View {
    @Environment(AppContainer.self) private var container
    @Environment(LayoutStore.self) private var layout

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "slider.horizontal.3")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)

            VStack(alignment: .leading, spacing: 4) {
                Text("Welcome to OpenUsage")
                    .font(.subheadline.weight(.semibold))
                Text("We set you up with the AI tools found on your Mac. Add or hide providers any time.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open Customize") {
                    withAnimation(Motion.modeSwitch) { layout.screen = .customize }
                }
                .controlSize(.small)
                .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                withAnimation(Motion.spring) { container.onboarding.dismissCustomizeHint() }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 16, height: 16)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(12)
        .cardSurface()
    }
}
