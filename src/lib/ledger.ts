import type { HeatmapDay, MetricLine } from "@/lib/plugin-types"
import { formatDayKey } from "@/lib/utils"

type ProgressLine = Extract<MetricLine, { type: "progress" }>
type HeatmapLine = Extract<MetricLine, { type: "heatmap" }>

/** Text lines the usage strip replaces when the card has a heatmap to read from. */
export const USAGE_TEXT_LABELS = new Set(["Today", "Yesterday", "Last 30 Days"])

export type LedgerParts = {
  /** Lines rendered as-is above the tiles (status badges, notes). */
  before: MetricLine[]
  /** Up to two percent limits shown as big tiles (Session, Weekly). */
  tiles: ProgressLine[]
  /** Every other progress line, shown as one table. */
  rows: ProgressLine[]
  heatmap: HeatmapLine | null
  /** Lines rendered as-is after the activity section. */
  after: MetricLine[]
}

export function splitLedgerLines(lines: MetricLine[]): LedgerParts {
  const parts: LedgerParts = { before: [], tiles: [], rows: [], heatmap: null, after: [] }
  const heatmap = lines.find((line): line is HeatmapLine => line.type === "heatmap") ?? null
  parts.heatmap = heatmap && heatmap.days.length > 0 ? heatmap : null

  for (const line of lines) {
    if (line.type === "progress") {
      if (line.format.kind === "percent" && parts.tiles.length < 2) parts.tiles.push(line)
      else parts.rows.push(line)
    } else if (line.type === "badge") {
      parts.before.push(line)
    } else if (line.type === "text") {
      if (parts.heatmap && USAGE_TEXT_LABELS.has(line.label)) continue
      parts.after.push(line)
    } else if (line.type === "histogram") {
      parts.after.push(line)
    }
  }
  return parts
}

export type UsageTotals = { cost: number; tokens: number }

function totalsOf(days: HeatmapDay[]): UsageTotals {
  let cost = 0
  let tokens = 0
  for (const day of days) {
    cost += day.value > 0 ? day.value : 0
    tokens += day.tokens && day.tokens > 0 ? day.tokens : 0
  }
  return { cost, tokens }
}

/** Today, yesterday and the last 30 days (today + 29 before), from the heatmap's days. */
export function usageSummary(days: HeatmapDay[], now: Date) {
  const byKey = new Map(days.map((day) => [day.date, day]))
  const dayAt = (offset: number) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset)
    return byKey.get(formatDayKey(date))
  }
  const pick = (offset: number) => {
    const day = dayAt(offset)
    return day ? totalsOf([day]) : { cost: 0, tokens: 0 }
  }
  const last30: HeatmapDay[] = []
  for (let offset = 0; offset < 30; offset++) {
    const day = dayAt(offset)
    if (day) last30.push(day)
  }
  return { today: pick(0), yesterday: pick(1), last30: totalsOf(last30) }
}

/** The last `count` calendar days ending today, zero-filled where the plugin sent nothing. */
export function recentDays(days: HeatmapDay[], now: Date, count: number): HeatmapDay[] {
  const byKey = new Map(days.map((day) => [day.date, day]))
  const out: HeatmapDay[] = []
  for (let offset = count - 1; offset >= 0; offset--) {
    const key = formatDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset))
    out.push(byKey.get(key) ?? { date: key, value: 0, tokens: 0 })
  }
  return out
}

/** "$1,015.74" */
export function formatMoney(value: number): string {
  return "$" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** "$1,016" above $100, "$33.86" below — for axis labels and graph stats. */
export function formatMoneyShort(value: number): string {
  return value >= 100 ? "$" + Math.round(value).toLocaleString("en-US") : formatMoney(value)
}

/** "41M", "1.1B", "950K" */
export function formatTokensShort(value: number): string {
  if (value <= 0) return "0"
  const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "K"]]
  for (const [divisor, suffix] of units) {
    if (value >= divisor) {
      const scaled = value / divisor
      return `${scaled.toFixed(scaled >= 10 ? 0 : 1)}${suffix}`
    }
  }
  return String(Math.round(value))
}

/** Round an axis maximum up to 1, 2, 2.5 or 5 × 10^n. */
export function niceCeiling(value: number): number {
  if (!(value > 0)) return 1
  const power = Math.pow(10, Math.floor(Math.log10(value)))
  const mantissa = value / power
  const step = mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 2.5 ? 2.5 : mantissa <= 5 ? 5 : 10
  return step * power
}
