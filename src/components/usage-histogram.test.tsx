import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { UsageHistogram, bucketHeight } from "@/components/usage-histogram"

describe("bucketHeight", () => {
  it("keeps zero and empty maxima as a 2px stub", () => {
    expect(bucketHeight(0, 10)).toBe(2)
    expect(bucketHeight(5, 0)).toBe(2)
  })

  it("scales to 14px at the maximum and never below 2px", () => {
    expect(bucketHeight(10, 10)).toBe(14)
    expect(bucketHeight(5, 10)).toBe(7)
    expect(bucketHeight(0.01, 10)).toBe(2)
  })
})

describe("UsageHistogram", () => {
  const rows = [
    { label: "alien-agency", buckets: [0, 31, 3, 0], value: "65%", note: "2h 58m", tooltip: "weekly 56% left" },
    { label: "carbon-creek", buckets: [0, 0, 0, 0], value: "cooling", note: "41m", color: "#ef4444" },
  ]

  it("renders one row per series with value, note and column captions", () => {
    render(
      <UsageHistogram
        rows={rows}
        columns={{ buckets: "requests", value: "5h left", note: "resets" }}
        axis="17:20 → 20:40 · 10-min buckets"
        brandColor="#4285F4"
      />
    )
    expect(screen.getByText("alien-agency")).toBeInTheDocument()
    expect(screen.getByText("65%")).toBeInTheDocument()
    expect(screen.getByText("2h 58m")).toBeInTheDocument()
    expect(screen.getByText("requests")).toBeInTheDocument()
    expect(screen.getByText("5h left")).toBeInTheDocument()
    expect(screen.getByText("17:20 → 20:40 · 10-min buckets")).toBeInTheDocument()
    expect(screen.getByText("Less")).toBeInTheDocument()
  })

  it("tints busy buckets with the brand colour and colours the value when asked", () => {
    const { container } = render(<UsageHistogram rows={rows} brandColor="#4285F4" />)
    const bars = container.querySelectorAll(".rounded-\\[1px\\]")
    expect(bars).toHaveLength(8)
    const peak = bars[1] as HTMLElement
    expect(peak.style.height).toBe("14px")
    expect(peak.style.background).toContain("#4285F4")
    const quiet = bars[0] as HTMLElement
    expect(quiet.style.height).toBe("2px")
    expect(quiet.style.background).toBe("")
    expect(screen.getByText("cooling").style.color).toBe("rgb(239, 68, 68)")
  })

  it("exposes the tooltip on the row", () => {
    render(<UsageHistogram rows={rows} />)
    expect(screen.getByTitle("weekly 56% left")).toBeInTheDocument()
  })

  it("announces every visible column, not just the label", () => {
    // An aria-label on the row replaces the name its children compose, so the
    // 5h figure and the reset have to be in it or nobody hears them.
    render(<UsageHistogram rows={rows} />)
    expect(screen.getByLabelText("alien-agency, 65%, 2h 58m, weekly 56% left")).toBeInTheDocument()
    expect(screen.getByLabelText("carbon-creek, cooling, 41m")).toBeInTheDocument()
  })
})
