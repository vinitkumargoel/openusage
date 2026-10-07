import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { PoolView } from "@/components/pool-view"
import { accountStatus, firstDry } from "@/lib/pool-stats"
import type { PoolAccount, PoolData } from "@/lib/plugin-types"

const NOW = Date.parse("2026-10-07T18:00:00Z")
const H5 = 5 * 60 * 60 * 1000
const at = (min: number) => new Date(NOW + min * 60_000).toISOString()

const account = (over: Partial<PoolAccount>): PoolAccount => ({
  id: "a",
  name: "alien-agency",
  state: "live",
  requests: [1, 2, 3],
  failures: [0, 1, 0],
  ok: 100,
  failed: 2,
  ...over,
})

const pool: PoolData = {
  five: { left: 49, resetsAt: at(71), periodMs: H5 },
  week: { left: 60, resetsAt: at(60 * 28), periodMs: 7 * 24 * 60 * 60 * 1000 },
  restWeek: { left: 97 },
  restFive: { left: 95 },
  counts: { total: 3, live: 1, cooling: 1, offline: 1, sampled: 2, unreachable: 0 },
  errorRate: 2.1,
  cohorts: [
    { count: 2, left: 30, resetsAt: at(60 * 28) },
    { count: 1, left: 87, resetsAt: at(60 * 100) },
  ],
  slots: ["20:40-20:50", "20:50-21:00", "21:00-21:10"],
  axis: "20:40 → 21:10 relay time · 10-min buckets",
  accounts: [
    // 90% used with 3h of the 5h window gone → dry in 20m.
    account({ id: "c", name: "carbon-creek", five: { left: 10, resetsAt: at(120), periodMs: H5 } }),
    account({ id: "e", name: "essential-philosophy", state: "cooling", cooldown: { reason: "credential_quota", until: at(40) } }),
    account({ id: "f", name: "forward-mantra", state: "offline" }),
  ],
}

describe("PoolView", () => {
  it("leads with the pool card, KPIs and one tile per account", () => {
    render(<PoolView pool={pool} now={NOW} />)
    expect(screen.getByText("Gemini pool")).toBeInTheDocument()
    expect(screen.getByText("carbon-creek dry ~20m")).toBeInTheDocument()
    expect(screen.getByText("live").previousElementSibling).toHaveTextContent("1/3")
    expect(screen.getByText("2 refill wk")).toBeInTheDocument()
    expect(screen.getByText("cooling · 40m")).toBeInTheDocument()
    expect(screen.getByText("Weekly refills")).toBeInTheDocument()
  })

  it("filters to issues and opens a sheet with every stat", async () => {
    render(<PoolView pool={pool} now={NOW} />)
    await userEvent.click(screen.getByRole("button", { name: /Issues/ }))
    expect(screen.queryByRole("button", { name: "carbon-creek details" })).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: "essential-philosophy details" }))
    const sheet = screen.getByRole("dialog", { name: "essential-philosophy details" })
    expect(within(sheet).getByText("Cooldown")).toBeInTheDocument()
    expect(within(sheet).getByText(/credential_quota/)).toBeInTheDocument()
    await userEvent.keyboard("{ArrowRight}")
    expect(screen.getByRole("dialog", { name: "forward-mantra details" })).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("status and first-dry skip accounts that aren't in rotation", () => {
    expect(accountStatus(pool.accounts[2], NOW).text).toBe("offline")
    expect(accountStatus(account({ five: { left: 100 } }), NOW).text).toBe("idle · full")
    expect(firstDry(pool, NOW)?.account.id).toBe("c")
  })
})
