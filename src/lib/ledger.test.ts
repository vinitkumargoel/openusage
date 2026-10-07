import { describe, expect, it } from "vitest"
import type { MetricLine } from "@/lib/plugin-types"
import { formatMoney, formatTokensShort, niceCeiling, recentDays, splitLedgerLines, usageSummary } from "@/lib/ledger"

const pct = (label: string, used: number): MetricLine => ({
  type: "progress", label, used, limit: 100, format: { kind: "percent" },
})

describe("splitLedgerLines", () => {
  it("puts the first two percent limits in tiles and the rest in rows", () => {
    const dollars: MetricLine = { type: "progress", label: "Extra usage spent", used: 4.2, limit: 50, format: { kind: "dollars" } }
    const parts = splitLedgerLines([pct("Session", 38), dollars, pct("Weekly", 41), pct("Sonnet", 12)])
    expect(parts.tiles.map((l) => l.label)).toEqual(["Session", "Weekly"])
    expect(parts.rows.map((l) => l.label)).toEqual(["Extra usage spent", "Sonnet"])
  })

  it("drops Today/Yesterday/Last 30 Days text only when a heatmap feeds the usage strip", () => {
    const texts: MetricLine[] = [
      { type: "text", label: "Today", value: "$1" },
      { type: "text", label: "Note", value: "hi" },
    ]
    expect(splitLedgerLines(texts).after.map((l) => l.label)).toEqual(["Today", "Note"])
    const heatmap: MetricLine = { type: "heatmap", label: "Activity", days: [{ date: "2026-10-07", value: 1, tokens: 5 }] }
    const parts = splitLedgerLines([...texts, heatmap])
    expect(parts.after.map((l) => l.label)).toEqual(["Note"])
    expect(parts.heatmap).toBe(heatmap)
  })

  it("keeps the usage text lines when the heatmap has no days", () => {
    const parts = splitLedgerLines([
      { type: "text", label: "Today", value: "$1" },
      { type: "heatmap", label: "Activity", days: [] },
    ])
    expect(parts.heatmap).toBeNull()
    expect(parts.after).toHaveLength(1)
  })

  it("keeps badges above the tiles", () => {
    const parts = splitLedgerLines([pct("Session", 1), { type: "badge", label: "Status", text: "No usage data" }])
    expect(parts.before.map((l) => l.label)).toEqual(["Status"])
  })
})

describe("usageSummary", () => {
  it("sums today, yesterday and the 30 days ending today", () => {
    const now = new Date(2026, 9, 7, 15)
    const summary = usageSummary(
      [
        { date: "2026-10-07", value: 10, tokens: 100 },
        { date: "2026-10-06", value: 5, tokens: 50 },
        { date: "2026-09-08", value: 1, tokens: 10 }, // 29 days before today: in
        { date: "2026-09-07", value: 99, tokens: 990 }, // 30 days before: out
      ],
      now,
    )
    expect(summary.today).toEqual({ cost: 10, tokens: 100 })
    expect(summary.yesterday).toEqual({ cost: 5, tokens: 50 })
    expect(summary.last30).toEqual({ cost: 16, tokens: 160 })
  })
})

describe("recentDays", () => {
  it("zero-fills missing days and ends today", () => {
    const days = recentDays([{ date: "2026-10-06", value: 3, tokens: 1 }], new Date(2026, 9, 7), 3)
    expect(days.map((d) => d.date)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"])
    expect(days.map((d) => d.value)).toEqual([0, 3, 0])
  })
})

describe("formatters", () => {
  it("formats money with thousands separators", () => {
    expect(formatMoney(1015.744)).toBe("$1,015.74")
  })
  it("formats tokens compactly", () => {
    expect(formatTokensShort(41_200_000)).toBe("41M")
    expect(formatTokensShort(1_120_000_000)).toBe("1.1B")
    expect(formatTokensShort(0)).toBe("0")
  })
  it("rounds axis ceilings to friendly steps", () => {
    expect(niceCeiling(103)).toBe(200)
    expect(niceCeiling(31.2)).toBe(50)
    expect(niceCeiling(0)).toBe(1)
  })
})
