import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderCard } from "@/components/provider-card"
import type { MetricLine } from "@/lib/plugin-types"
import { formatDayKey } from "@/lib/utils"
import { useAppPreferencesStore } from "@/stores/app-preferences-store"

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }))
vi.mock("@/lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings")>()),
  saveHeatmapUnit: vi.fn(() => Promise.resolve()),
}))
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ render }: { render: (props: Record<string, unknown>) => ReactNode }) => render({}),
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

const H = 3600e3

function lines(now: number): MetricLine[] {
  const today = formatDayKey(new Date(now))
  const yesterday = formatDayKey(new Date(now - 24 * H))
  return [
    // 82% used with 40% of the 5h window gone: over pace.
    { type: "progress", label: "Session", used: 82, limit: 100, format: { kind: "percent" }, resetsAt: new Date(now + 3 * H).toISOString(), periodDurationMs: 5 * H },
    { type: "progress", label: "Weekly", used: 100, limit: 100, format: { kind: "percent" }, resetsAt: new Date(now + 24 * H).toISOString(), periodDurationMs: 168 * H },
    { type: "progress", label: "Sonnet", used: 12, limit: 100, format: { kind: "percent" } },
    { type: "progress", label: "Extra usage spent", used: 4.2, limit: 50, format: { kind: "dollars" } },
    { type: "heatmap", label: "Activity", format: { kind: "dollars" }, days: [
      { date: today, value: 1015.744, tokens: 41_200_000 },
      { date: yesterday, value: 2, tokens: 3_000_000 },
    ] },
    { type: "text", label: "Today", value: "$1,015.74 · 41M tokens" },
  ]
}

describe("ProviderCard ledger layout", () => {
  beforeEach(() => {
    const data = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    })
    useAppPreferencesStore.getState().resetState()
  })

  it("shows limit tiles with pace outcome, a limits table and a usage strip", () => {
    const now = Date.now()
    render(<ProviderCard name="Claude" displayMode="used" layout="ledger" lines={lines(now)} />)

    expect(screen.getByText("Over pace")).toBeInTheDocument()
    expect(screen.getByText(/^Runs out in/)).toBeInTheDocument()
    expect(screen.getByText("Maxed")).toBeInTheDocument()
    expect(screen.getByText("Blocked until reset")).toBeInTheDocument()
    expect(screen.getByText("Sonnet")).toBeInTheDocument()
    expect(screen.getByText("$4.20")).toBeInTheDocument()
    // Usage strip replaces the plugin's Today text line.
    expect(screen.getAllByText("$1,015.74").length).toBeGreaterThan(0)
    expect(screen.queryByText("$1,015.74 · 41M tokens")).not.toBeInTheDocument()
  })

  it("switches the usage unit and the activity view", async () => {
    const now = Date.now()
    render(<ProviderCard name="Claude" displayMode="used" layout="ledger" lines={lines(now)} />)

    await userEvent.click(screen.getByRole("button", { name: "Tokens" }))
    expect(useAppPreferencesStore.getState().heatmapUnit).toBe("tokens")
    expect(screen.getAllByText("41M").length).toBeGreaterThan(0)

    await userEvent.click(screen.getByRole("button", { name: "Graph" }))
    expect(screen.getByRole("img", { name: /Daily tokens for the last 30 days/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "7D" }))
    expect(screen.getByRole("img", { name: /last 7 days/ })).toBeInTheDocument()
    expect(localStorage.getItem("openusage.ledger.activityView")).toBe("graph")
  })

  it("leaves other providers on the plain list", () => {
    render(<ProviderCard name="Other" displayMode="used" lines={lines(Date.now())} />)
    expect(screen.queryByText("Over pace")).not.toBeInTheDocument()
    expect(screen.getByText("$1,015.74 · 41M tokens")).toBeInTheDocument()
  })
})
