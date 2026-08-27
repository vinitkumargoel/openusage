import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  UsageHeatmap,
  formatHeatmapValue,
  intensityLevel,
  quartileThresholds,
} from "@/components/usage-heatmap"
import { formatDayKey } from "@/lib/utils"

describe("quartileThresholds", () => {
  it("returns null when all values are zero", () => {
    expect(quartileThresholds([])).toBeNull()
    expect(quartileThresholds([0, 0, 0])).toBeNull()
  })

  it("returns p25/p50/p75 of the non-zero values", () => {
    const thresholds = quartileThresholds([0, 1, 2, 3, 4])
    expect(thresholds).toEqual([2, 3, 4])
  })
})

describe("intensityLevel", () => {
  const thresholds: [number, number, number] = [1, 2, 3]

  it("maps zero and missing thresholds to level 0", () => {
    expect(intensityLevel(0, thresholds)).toBe(0)
    expect(intensityLevel(5, null)).toBe(0)
  })

  it("maps values into quartile buckets", () => {
    expect(intensityLevel(0.5, thresholds)).toBe(1)
    expect(intensityLevel(1, thresholds)).toBe(1)
    expect(intensityLevel(1.5, thresholds)).toBe(2)
    expect(intensityLevel(2.5, thresholds)).toBe(3)
    expect(intensityLevel(99, thresholds)).toBe(4)
  })
})

describe("formatHeatmapValue", () => {
  it("shows No usage for zero", () => {
    expect(formatHeatmapValue(0, { kind: "dollars" })).toBe("No usage")
  })

  it("formats dollars, percent, and counts", () => {
    expect(formatHeatmapValue(4.309, { kind: "dollars" })).toBe("$4.31")
    expect(formatHeatmapValue(12, { kind: "percent" })).toBe("12%")
    expect(formatHeatmapValue(1500, { kind: "count", suffix: "tokens" })).toBe("1,500 tokens")
    expect(formatHeatmapValue(7, undefined)).toBe("7")
  })
})

describe("UsageHeatmap", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("renders cells with value tooltips and a legend", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 27, 12, 0, 0))

    const todayKey = formatDayKey(new Date())
    render(
      <UsageHeatmap
        days={[{ date: todayKey, value: 4.31 }]}
        format={{ kind: "dollars" }}
        brandColor="#DE7356"
      />
    )

    expect(screen.getByLabelText(/\$4\.31 · Thu, Aug 27/)).toBeInTheDocument()
    expect(screen.getByText("Less")).toBeInTheDocument()
    expect(screen.getByText("More")).toBeInTheDocument()
    // Month labels for the 20-week window ending in Aug
    expect(screen.getByText("Aug")).toBeInTheDocument()
    expect(screen.getByText("May")).toBeInTheDocument()
  })

  it("colors active cells with the brand color and leaves empty days unstyled", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 27, 12, 0, 0))

    const todayKey = formatDayKey(new Date())
    render(
      <UsageHeatmap
        days={[{ date: todayKey, value: 9 }]}
        format={{ kind: "dollars" }}
        brandColor="#DE7356"
      />
    )

    const activeCell = screen.getByLabelText(/\$9\.00/)
    expect(activeCell.style.background).toContain("#DE7356")

    const emptyCell = screen.getAllByLabelText(/No usage/)[0]
    expect(emptyCell.style.background).toBe("")
  })

  it("shows a tooltip while hovering a cell", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 27, 12, 0, 0))

    const todayKey = formatDayKey(new Date())
    render(
      <UsageHeatmap
        days={[{ date: todayKey, value: 4.31 }]}
        format={{ kind: "dollars" }}
        brandColor="#DE7356"
      />
    )

    const cell = screen.getByLabelText(/\$4\.31/)
    fireEvent.mouseOver(cell, { clientX: 50, clientY: 80 })
    expect(screen.getByText("$4.31 · Thu, Aug 27")).toBeInTheDocument()
    fireEvent.mouseMove(cell, { clientX: 60, clientY: 90 })
    fireEvent.mouseLeave(cell.parentElement as HTMLElement)
    expect(screen.queryByText("$4.31 · Thu, Aug 27")).toBeNull()
  })

  it("renders all cells empty when there is no usage", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 27, 12, 0, 0))

    render(<UsageHeatmap days={[]} format={{ kind: "dollars" }} brandColor="#DE7356" />)

    expect(screen.queryByLabelText(/\$/)).toBeNull()
    expect(screen.getAllByLabelText(/No usage/).length).toBeGreaterThan(100)
  })
})
