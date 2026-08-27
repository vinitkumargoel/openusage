import { describe, expect, it } from "vitest"

import { adjustBrandColor, getRelativeLuminance } from "@/lib/color"

describe("getRelativeLuminance", () => {
  it("returns 0 for invalid hex", () => {
    expect(getRelativeLuminance("nope")).toBe(0)
    expect(getRelativeLuminance("#12")).toBe(0)
    expect(getRelativeLuminance("#gggggg")).toBe(0)
  })

  it("supports 3-digit and 4-digit hex (alpha ignored)", () => {
    const lum3 = getRelativeLuminance("#fff")
    const lum4 = getRelativeLuminance("#ffff")
    expect(lum3).toBeGreaterThan(0.9)
    expect(lum4).toBeGreaterThan(0.9)
  })

  it("ignores alpha in 8-digit hex", () => {
    const lum1 = getRelativeLuminance("#000000ff")
    const lum2 = getRelativeLuminance("#00000000")
    expect(lum1).toBe(0)
    expect(lum2).toBe(0)
  })
})

describe("adjustBrandColor", () => {
  it("returns the fallback when no brand color is set", () => {
    expect(adjustBrandColor(undefined, false, "currentColor")).toBe("currentColor")
  })

  it("turns near-black brands white in dark mode", () => {
    expect(adjustBrandColor("#000000", true, "currentColor")).toBe("#ffffff")
    expect(adjustBrandColor("#000000", false, "currentColor")).toBe("#000000")
  })

  it("falls back for near-white brands in light mode", () => {
    expect(adjustBrandColor("#ffffff", false, "currentColor")).toBe("currentColor")
    expect(adjustBrandColor("#ffffff", true, "currentColor")).toBe("#ffffff")
  })

  it("passes normal brand colors through", () => {
    expect(adjustBrandColor("#DE7356", false, "currentColor")).toBe("#DE7356")
    expect(adjustBrandColor("#DE7356", true, "currentColor")).toBe("#DE7356")
  })
})

