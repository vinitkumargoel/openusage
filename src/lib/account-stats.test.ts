import { describe, expect, it } from "vitest"
import { burn, elapsedPct, headroom, pickBest, weeklyPace } from "@/lib/account-stats"
import type { AccountRow } from "@/lib/plugin-types"

const NOW = Date.parse("2026-10-07T18:00:00Z")
const H5 = 5 * 60 * 60 * 1000

const row = (id: string, five: number, extra: Partial<AccountRow> = {}): AccountRow => ({
  id,
  name: `a${id}`,
  active: false,
  bars: [{ label: "5h", used: five, resetsAt: "2026-10-07T20:00:00Z", periodMs: H5 }],
  ...extra,
})

describe("account-stats", () => {
  it("headroom is the tightest window", () => {
    const r = row("1", 20, { bars: [{ label: "5h", used: 20 }, { label: "7d", used: 91 }] })
    expect(headroom(r)).toBe(9)
  })

  it("best skips active and flagged accounts and picks most headroom", () => {
    const rows = [row("1", 0, { active: true }), row("2", 0, { flag: "expired" }), row("3", 30), row("4", 5)]
    expect(pickBest(rows)?.id).toBe("4")
    expect(pickBest([row("1", 0, { active: true })])).toBeUndefined()
  })

  it("elapsed share comes from reset time and window length", () => {
    // Resets in 2h of a 5h window → 60% gone.
    expect(elapsedPct(row("1", 0).bars[0], NOW)).toBeCloseTo(60)
    expect(elapsedPct({ label: "5h", used: 1 }, NOW)).toBeNull()
  })

  it("burn projects the window end, or when the limit hits", () => {
    expect(burn(row("1", 0).bars[0], NOW).text).toBe("idle")
    expect(burn(row("1", 30).bars[0], NOW).text).toBe("on pace for 50%")
    // 90% used with 60% of the window gone → limit after 66.7% → in 20m.
    expect(burn(row("1", 90).bars[0], NOW)).toEqual({ text: "hits limit in ~20m", short: "limit ~20m", tone: "bad" })
  })

  it("weekly pace uses cswap's expected percent", () => {
    expect(weeklyPace({ label: "7d", used: 55, expected: 67.2 }, NOW)?.text).toBe("12% under pace")
    expect(weeklyPace({ label: "7d", used: 80, expected: 60 }, NOW)?.text).toBe("20% over pace")
    expect(weeklyPace({ label: "7d", used: 80 }, NOW)).toBeNull()
  })
})
