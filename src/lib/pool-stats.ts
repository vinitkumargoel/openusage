import type { AccountBar, AccountRow, PoolAccount, PoolData, PoolWindow } from "@/lib/plugin-types"
import { burn, msToLimit, type Tone } from "@/lib/account-stats"
import { formatCompactDuration } from "@/lib/pace-tooltip"

/** A pool window as a usage bar, so the account-stats helpers apply. */
export function asBar(label: string, win?: PoolWindow): AccountBar | undefined {
  if (!win) return undefined
  return { label, used: 100 - win.left, resetsAt: win.resetsAt, periodMs: win.periodMs }
}

/** Shim for AccountRing: outer ring 5h, inner ring weekly. */
export function ringRow(a: Pick<PoolAccount, "five" | "week"> & { state?: PoolAccount["state"] }): AccountRow {
  const bars = [asBar("5h", a.five), asBar("7d", a.week)].filter((b): b is AccountBar => Boolean(b))
  return { id: "", name: "", active: false, flag: a.state === "offline" || a.state === "sampling" ? "expired" : undefined, bars }
}

/** Percent left before the tightest Gemini window runs out. */
export function poolHeadroom(a: PoolAccount): number | null {
  const lefts = [a.five?.left, a.week?.left].filter((v): v is number => typeof v === "number")
  return lefts.length ? Math.round(Math.min(...lefts)) : null
}

export function isIssue(a: PoolAccount): boolean {
  return a.state !== "live" || a.tag === "model"
}

export function isLow(a: PoolAccount): boolean {
  const h = poolHeadroom(a)
  return h !== null && h < 25
}

/** Short status for a tile: cooling, offline, sampling, or the 5h burn. */
export function accountStatus(a: PoolAccount, now: number): { text: string; tone: Tone } {
  if (a.state === "cooling") return { text: `cooling${a.cooldown ? ` · ${shortUntil(now, a.cooldown.until)}` : ""}`, tone: "bad" }
  if (a.state === "offline") return { text: "offline", tone: "bad" }
  if (a.state === "sampling") return { text: "sampling…", tone: "muted" }
  const five = asBar("5h", a.five)
  if (!five) return { text: "wk only", tone: "muted" }
  if (five.used <= 0 && !a.five?.resetsAt) return { text: "idle · full", tone: "muted" }
  const b = burn(five, now)
  return { text: b.short.replace(/^limit/, "dry"), tone: b.tone }
}

export function shortUntil(now: number, iso?: string): string {
  if (!iso) return ""
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return ""
  return formatCompactDuration(ms) ?? "now"
}

/** The live account whose 5h window runs dry soonest at its current rate. */
export function firstDry(pool: PoolData, now: number): { account: PoolAccount; ms: number } | null {
  let best: { account: PoolAccount; ms: number } | null = null
  for (const a of pool.accounts) {
    if (a.state !== "live") continue
    const bar = asBar("5h", a.five)
    const ms = bar ? msToLimit(bar, now) : null
    if (ms !== null && (!best || ms < best.ms)) best = { account: a, ms }
  }
  return best
}

export const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

export function compact(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

export const POOL_FILTERS = {
  all: { label: "All", test: () => true },
  live: { label: "Live", test: (a: PoolAccount) => a.state === "live" },
  low: { label: "Low", test: isLow },
  issues: { label: "Issues", test: isIssue },
} as const
export type PoolFilterKey = keyof typeof POOL_FILTERS

const leftOf = (a: PoolAccount) => poolHeadroom(a) ?? 101
export const POOL_SORTS = {
  driest: { label: "Driest", cmp: null },
  most: { label: "Most left", cmp: (a: PoolAccount, b: PoolAccount) => leftOf(b) - leftOf(a) },
  busy: { label: "Busiest", cmp: (a: PoolAccount, b: PoolAccount) => sum(b.requests) - sum(a.requests) },
  name: { label: "Name", cmp: (a: PoolAccount, b: PoolAccount) => a.name.localeCompare(b.name) },
} as const
export type PoolSortKey = keyof typeof POOL_SORTS
