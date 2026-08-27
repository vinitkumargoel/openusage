import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  applySnapshot,
  loadRecordedHeatmapLine,
  recordUsageSnapshot,
  type ProviderHistory,
} from "@/lib/usage-history"
import { formatDayKey } from "@/lib/utils"
import type { MetricLine } from "@/lib/plugin-types"

const storeState = new Map<string, unknown>()
const storeSaveMock = vi.fn()

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get<T>(key: string): Promise<T | undefined> {
      if (!storeState.has(key)) return undefined
      return storeState.get(key) as T
    }
    async set<T>(key: string, value: T): Promise<void> {
      storeState.set(key, value)
    }
    async save(): Promise<void> {
      storeSaveMock()
    }
  },
}))

const NOW = new Date(2026, 7, 27, 12, 0, 0)
const TODAY_KEY = formatDayKey(NOW)

function progressLine(used: number, label = "Session"): MetricLine {
  return { type: "progress", label, used, limit: 100, format: { kind: "percent" } }
}

describe("applySnapshot", () => {
  it("returns null when the plugin emits its own heatmap", () => {
    const lines: MetricLine[] = [
      progressLine(10),
      { type: "heatmap", label: "Activity", days: [] },
    ]
    expect(applySnapshot(null, lines, NOW)).toBeNull()
  })

  it("returns null when there is no progress line", () => {
    const lines: MetricLine[] = [{ type: "text", label: "Status", value: "ok" }]
    expect(applySnapshot(null, lines, NOW)).toBeNull()
  })

  it("baselines on first snapshot without recording usage", () => {
    const next = applySnapshot(null, [progressLine(40)], NOW)
    expect(next).toEqual({
      days: {},
      last: { label: "Session", used: 40 },
      format: { kind: "percent" },
    })
  })

  it("accumulates increases into today's bucket", () => {
    const first = applySnapshot(null, [progressLine(40)], NOW)
    const second = applySnapshot(first, [progressLine(47)], NOW)
    expect(second?.days).toEqual({ [TODAY_KEY]: 7 })
    const third = applySnapshot(second, [progressLine(50)], NOW)
    expect(third?.days).toEqual({ [TODAY_KEY]: 10 })
  })

  it("counts the new used amount when the period resets", () => {
    const first = applySnapshot(null, [progressLine(80)], NOW)
    const afterReset = applySnapshot(first, [progressLine(5)], NOW)
    expect(afterReset?.days).toEqual({ [TODAY_KEY]: 5 })
    expect(afterReset?.last).toEqual({ label: "Session", used: 5 })
  })

  it("records nothing when the value is unchanged", () => {
    const first = applySnapshot(null, [progressLine(40)], NOW)
    const second = applySnapshot(first, [progressLine(40)], NOW)
    expect(second?.days).toEqual({})
  })

  it("re-baselines without a delta when the primary label changes", () => {
    const first = applySnapshot(null, [progressLine(40, "Session")], NOW)
    const second = applySnapshot(first, [progressLine(90, "Monthly")], NOW)
    expect(second?.days).toEqual({})
    expect(second?.last).toEqual({ label: "Monthly", used: 90 })
  })

  it("prunes entries older than 400 days", () => {
    const history: ProviderHistory = {
      days: { "2024-01-01": 3, [TODAY_KEY]: 1 },
      last: { label: "Session", used: 40 },
    }
    const next = applySnapshot(history, [progressLine(41)], NOW)
    expect(next?.days["2024-01-01"]).toBeUndefined()
    expect(next?.days[TODAY_KEY]).toBe(2)
  })
})

describe("store round-trip", () => {
  beforeEach(() => {
    storeState.clear()
    storeSaveMock.mockReset()
  })

  it("records snapshots and loads them back as a heatmap line", async () => {
    await recordUsageSnapshot("cursor", [progressLine(40)], NOW)
    await recordUsageSnapshot("cursor", [progressLine(52)], NOW)

    const line = await loadRecordedHeatmapLine("cursor")
    expect(line).toEqual({
      type: "heatmap",
      label: "Activity",
      days: [{ date: TODAY_KEY, value: 12 }],
      format: { kind: "percent" },
    })
    expect(storeSaveMock).toHaveBeenCalled()
  })

  it("returns null when nothing non-zero has been recorded", async () => {
    expect(await loadRecordedHeatmapLine("cursor")).toBeNull()
    await recordUsageSnapshot("cursor", [progressLine(40)], NOW)
    expect(await loadRecordedHeatmapLine("cursor")).toBeNull()
  })

  it("does not persist for plugins that emit their own heatmap", async () => {
    const lines: MetricLine[] = [
      progressLine(10),
      { type: "heatmap", label: "Activity", days: [{ date: TODAY_KEY, value: 1 }] },
    ]
    await recordUsageSnapshot("claude", lines, NOW)
    expect(storeState.has("claude")).toBe(false)
  })
})
