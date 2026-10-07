import type { AccountBar, AccountRow } from "@/lib/plugin-types"
import { formatCompactDuration } from "@/lib/pace-tooltip"

/** Tone of a usage number: fine, getting full, at the limit. */
export type Tone = "ok" | "warn" | "bad" | "muted"

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-green-500",
  warn: "text-amber-500",
  bad: "text-red-500",
  muted: "text-muted-foreground",
}

export function usedTone(used: number): Tone {
  if (used >= 90) return "bad"
  if (used >= 70) return "warn"
  return "ok"
}

export function barOf(row: AccountRow, label: string): AccountBar | undefined {
  return row.bars.find((b) => b.label === label)
}

/** Percent left before the tightest window runs out. */
export function headroom(row: AccountRow): number {
  if (row.bars.length === 0) return 0
  return Math.round(Math.min(...row.bars.map((b) => 100 - b.used)))
}

export function isReady(row: AccountRow): boolean {
  return !row.active && !row.flag
}

/** Ready account with the most headroom; ties go to the sooner 5h reset. */
export function pickBest(rows: AccountRow[]): AccountRow | undefined {
  const resetMs = (r: AccountRow) => Date.parse(barOf(r, "5h")?.resetsAt ?? "") || Infinity
  return rows
    .filter(isReady)
    .sort((a, b) => headroom(b) - headroom(a) || resetMs(a) - resetMs(b) || Number(a.id) - Number(b.id))[0]
}

export function until(now: number, iso?: string): string {
  if (!iso) return ""
  return formatCompactDuration(Date.parse(iso) - now) ?? "now"
}

/** Share of the window already gone, 0-100. Null without reset or length. */
export function elapsedPct(bar: AccountBar, now: number): number | null {
  if (!bar.resetsAt || !bar.periodMs) return null
  const left = Date.parse(bar.resetsAt) - now
  if (!Number.isFinite(left)) return null
  return Math.max(0, Math.min(100, ((bar.periodMs - left) / bar.periodMs) * 100))
}

const BURN_MIN_ELAPSED_MS = 10 * 60 * 1000

/** Where the 5h window lands at this rate: used ÷ share of window gone. */
export function burn(bar: AccountBar, now: number): { text: string; short: string; tone: Tone } {
  if (bar.used <= 0) return { text: "idle", short: "idle", tone: "muted" }
  const gone = elapsedPct(bar, now)
  if (gone === null || !bar.periodMs || (gone / 100) * bar.periodMs < BURN_MIN_ELAPSED_MS) {
    return { text: "window just started", short: "just started", tone: "muted" }
  }
  const projected = (bar.used / gone) * 100
  if (projected <= 100) {
    const pct = Math.round(projected)
    return { text: `on pace for ${pct}%`, short: `pace ${pct}%`, tone: projected >= 70 ? "warn" : "muted" }
  }
  const elapsedMs = (gone / 100) * bar.periodMs
  const hitInMs = (elapsedMs * 100) / bar.used - elapsedMs
  const hit = formatCompactDuration(hitInMs) ?? "<1m"
  return { text: `hits limit in ~${hit}`, short: `limit ~${hit}`, tone: "bad" }
}

/** Weekly use against an even spend. Positive `delta` = under pace. */
export function weeklyPace(bar: AccountBar, now: number): { expected: number; delta: number; text: string } | null {
  const expected = bar.expected ?? elapsedPct(bar, now)
  if (expected === null) return null
  const delta = Math.round(expected - bar.used)
  return { expected, delta, text: delta >= 0 ? `${delta}% under pace` : `${-delta}% over pace` }
}

/** "abc@x.com" → "x.com"; whatever is after the @ in the detail line. */
export function domainOf(row: AccountRow): string {
  const at = row.detail?.indexOf("@") ?? -1
  return at >= 0 ? row.detail!.slice(at + 1) : (row.detail ?? "")
}

export const SORTS = {
  free: { label: "Most left", cmp: (a: AccountRow, b: AccountRow) => headroom(b) - headroom(a) || Number(a.id) - Number(b.id) },
  reset: {
    label: "Resets soonest",
    cmp: (a: AccountRow, b: AccountRow) =>
      (Date.parse(barOf(a, "5h")?.resetsAt ?? "") || Infinity) - (Date.parse(barOf(b, "5h")?.resetsAt ?? "") || Infinity) ||
      Number(a.id) - Number(b.id),
  },
  slot: { label: "Slot", cmp: (a: AccountRow, b: AccountRow) => Number(a.id) - Number(b.id) },
} as const
export type SortKey = keyof typeof SORTS

export const FILTERS = {
  all: { label: "All", test: (r: AccountRow) => !r.active },
  ready: { label: "Ready", test: isReady },
  busy: { label: "In use", test: (r: AccountRow) => !r.active && (barOf(r, "5h")?.used ?? 0) > 0 },
  weekly: { label: "Has 7d", test: (r: AccountRow) => !r.active && Boolean(barOf(r, "7d")) },
} as const
export type FilterKey = keyof typeof FILTERS
