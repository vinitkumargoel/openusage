import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

const RESET_5H = "2026-10-07T20:00:00Z"
const RESET_7D = "2026-10-11T08:00:00Z"

function account(overrides) {
  return Object.assign(
    {
      number: 1,
      email: "personal@example.com",
      active: false,
      usageStatus: "ok",
      usage: {
        fiveHour: { pct: 20, resetsAt: RESET_5H },
        sevenDay: { pct: 30, resetsAt: RESET_7D },
      },
    },
    overrides
  )
}

function withList(ctx, result) {
  ctx.host.cswap = { list: vi.fn(() => result) }
  return ctx
}

function ok(accounts) {
  return { status: "ok", data: { schemaVersion: 1, accounts } }
}

describe("claude-accounts plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("throws an install hint when cswap is missing", async () => {
    const plugin = await loadPlugin()
    const ctx = withList(makeCtx(), { status: "not_installed" })
    expect(() => plugin.probe(ctx)).toThrow("cswap not installed")
  })

  it("throws cswap's own error message", async () => {
    const plugin = await loadPlugin()
    expect(() => plugin.probe(withList(makeCtx(), { status: "error", message: "cswap timed out" }))).toThrow(
      "cswap failed: cswap timed out"
    )
    const payloadError = { status: "ok", data: { schemaVersion: 1, error: { type: "X", message: "boom" } } }
    expect(() => plugin.probe(withList(makeCtx(), payloadError))).toThrow("cswap failed: boom")
  })

  it("throws a setup hint when no accounts are saved", async () => {
    const plugin = await loadPlugin()
    expect(() => plugin.probe(withList(makeCtx(), ok([])))).toThrow("cswap add")
  })

  it("shows the active account on the overview and one row per account", async () => {
    const plugin = await loadPlugin()
    const ctx = withList(
      makeCtx(),
      ok([
        account({ number: 2, email: "work@example.com", alias: "work", active: true }),
        account({ number: 1 }),
      ])
    )
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("2 accounts")
    const session = result.lines.find((l) => l.label === "Session")
    expect(session).toMatchObject({ used: 20, limit: 100, resetsAt: RESET_5H })
    const ready = result.lines.find((l) => l.label === "Ready")
    expect(ready.value).toBe("1 of 1 to switch to")

    const rows = result.lines.find((l) => l.type === "accounts").rows
    expect(rows.map((r) => r.id)).toEqual(["1", "2"])
    expect(rows[1]).toMatchObject({ name: "work", detail: "work@example.com", active: true })
    expect(rows[0].name).toBe("personal")
    expect(rows[0].bars).toEqual([
      { label: "5h", used: 20, resetsAt: RESET_5H },
      { label: "7d", used: 30, resetsAt: RESET_7D },
    ])
  })

  it("flags accounts at the limit, expired or disabled, and they don't count as ready", async () => {
    const plugin = await loadPlugin()
    const ctx = withList(
      makeCtx(),
      ok([
        account({ number: 1, active: true }),
        account({ number: 2, usage: { fiveHour: { pct: 95 }, sevenDay: { pct: 10 } } }),
        account({ number: 3, usageStatus: "token_expired", usage: null }),
        account({ number: 4, disabled: true }),
        account({ number: 5 }),
      ])
    )
    const result = plugin.probe(ctx)
    const rows = result.lines.find((l) => l.type === "accounts").rows
    expect(rows.map((r) => r.flag)).toEqual([undefined, "limit", "expired", "off", undefined])
    expect(result.lines.find((l) => l.label === "Ready").value).toBe("1 of 4 to switch to")
  })

  it("leaves out windows the plan doesn't have instead of showing 0%", async () => {
    const plugin = await loadPlugin()
    const noWeek = account({ number: 1, active: true, usage: { fiveHour: { pct: 7, resetsAt: RESET_5H } } })
    const result = plugin.probe(withList(makeCtx(), ok([noWeek])))
    expect(result.lines.find((l) => l.label === "Weekly")).toBeUndefined()
    const rows = result.lines.find((l) => l.type === "accounts").rows
    expect(rows[0].bars).toEqual([{ label: "5h", used: 7, resetsAt: RESET_5H }])
  })

  it("falls back to the last good reading when usage is stale", async () => {
    const plugin = await loadPlugin()
    const stale = account({
      number: 1,
      active: true,
      usageStatus: "unavailable",
      usage: null,
      lastGoodUsage: { fiveHour: { pct: 41 }, sevenDay: { pct: 12 } },
    })
    const result = plugin.probe(withList(makeCtx(), ok([stale])))
    expect(result.lines.find((l) => l.label === "Session").used).toBe(41)
    expect(result.plan).toBe("1 account")
  })
})
