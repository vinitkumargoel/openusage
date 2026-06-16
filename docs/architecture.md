# Architecture

A high-level map of how OpenUsage is put together, for people working on the code. For what the app
*does*, start with the [behavior docs](README.md).

## The shape of the app

OpenUsage is a single SwiftPM executable — there is no Xcode project. It's a menu-bar app: a SwiftUI
interface hosted inside an AppKit status item and popover. The code is grouped by role:

- `App/` — startup and the AppKit bridge (status item, popover, the app entry point).
- `Models/` — the small value types the rest of the app speaks in (`MetricLine`, `WidgetData`, descriptors).
- `Providers/` — one folder per provider (Claude, Codex, Cursor, Devin, Grok).
- `Stores/` — the mutable state the UI observes.
- `Services/` — shared infrastructure (HTTP, the local API, process running).
- `Support/` — small shared helpers (formatting, parsing, animations).
- `Views/` — the SwiftUI screens (dashboard, customize, settings, menu-bar strip).

## Composition root

`AppContainer` is the one place that wires everything together. At launch it builds the list of
providers, turns it into a `WidgetRegistry`, creates the stores, starts the periodic refresh loop, and
starts the local HTTP API. Everything else receives what it needs from here rather than reaching for
globals, which keeps the pieces testable in isolation.

## The provider pipeline

Each provider is a small module that conforms to `ProviderRuntime`. A refresh flows through three parts:

1. **Auth store** — reads credentials that already exist on the machine (config files, keychain). OpenUsage
   never asks the user to paste tokens.
2. **Usage client** — makes the HTTP calls to the provider's API.
3. **Mapper** — turns the provider's response into the app's own vocabulary: a `ProviderSnapshot`
   containing `MetricLine` values (`.progress`, `.text`, `.badge`).

Because every provider produces the same normalized `MetricLine` shapes, the UI renders them all the same
way and doesn't need to know provider-specific details. To add one, see
[Adding a provider](adding-a-provider.md).

## Stores

The UI reads from a few observable stores:

- `WidgetDataStore` — the latest snapshot per provider, plus refresh and caching. This is what the
  dashboard rows and menu-bar strip read.
- `LayoutStore` — which metrics are shown, the provider/metric order, and which metrics are pinned to the
  menu bar.
- `ProviderEnablementStore` — which providers the user has turned on or off.

Refresh runs on a timer in `AppContainer`; each pass respects the cache, so the network is only hit once a
snapshot has actually expired.

## The AppKit bridge

macOS menu-bar apps live in an `NSStatusItem` and show their content in an `NSPopover`. `App/` owns that
AppKit layer and hosts the SwiftUI views inside it, so the bulk of the UI can stay plain SwiftUI.

## Platform support

OpenUsage runs on macOS 15 (Sequoia) and later. It is built against the latest SDK and back-deploys:
on macOS 26 (Tahoe) it uses the system's Liquid Glass controls, and on macOS 15 it falls back to the
standard controls with the same behavior (the footer still pins, the buttons keep their states). Every
one of those version checks lives in a single file — `Support/LiquidGlassFallbacks.swift` — so the views
stay free of `#available` checks.

## Local HTTP API

A small loopback server exposes the current usage as JSON on `127.0.0.1:6736` for other local tools. See
[Local HTTP API](local-http-api.md) for the endpoints and the privacy tradeoff.
