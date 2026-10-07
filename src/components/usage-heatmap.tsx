import { memo, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useDarkMode } from "@/hooks/use-dark-mode"
import { adjustBrandColor, FALLBACK_BASE_COLOR, LEVEL_MIX_DARK, LEVEL_MIX_LIGHT } from "@/lib/color"
import { formatCountNumber, formatDayKey } from "@/lib/utils"
import { useAppPreferencesStore } from "@/stores/app-preferences-store"
import type { HeatmapDay, ProgressFormat } from "@/lib/plugin-types"

export const HEATMAP_WEEKS = 20

const CELL_PX = 10
const GAP_PX = 3
const PITCH_PX = CELL_PX + GAP_PX

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

// Tooltip sits this far above the pointer, and never closer than this to a
// window edge.
const TOOLTIP_GAP_PX = 10
const TOOLTIP_EDGE_PX = 6

type Cell = {
  key: string
  date: Date
  /** Value in the selected unit; drives the cell color. */
  value: number
  /** Value in the other unit, shown in the tooltip. Absent when unavailable. */
  altValue?: number
  level: number
}

export function formatHeatmapValue(value: number, format?: ProgressFormat | null): string {
  if (value <= 0) return "No usage"
  if (format?.kind === "dollars") return `$${value.toFixed(2)}`
  if (format?.kind === "percent") return `${formatCountNumber(value)}%`
  if (format?.kind === "count") return `${formatCountNumber(value)} ${format.suffix}`
  return formatCountNumber(value)
}

/** Compact token count, e.g. 3400000 -> "3.4M tokens". */
export function formatTokenCount(value: number): string {
  if (value <= 0) return "No usage"
  const units = [
    { threshold: 1e9, divisor: 1e9, suffix: "B" },
    { threshold: 1e6, divisor: 1e6, suffix: "M" },
    { threshold: 1e3, divisor: 1e3, suffix: "K" },
  ]
  for (const unit of units) {
    if (value >= unit.threshold) {
      const scaled = value / unit.divisor
      const digits = scaled >= 10 ? 0 : 1
      return `${scaled.toFixed(digits)}${unit.suffix} tokens`
    }
  }
  return `${formatCountNumber(value)} tokens`
}

/** Quartile thresholds (p25/p50/p75) of the non-zero values, or null if all zero. */
export function quartileThresholds(values: number[]): [number, number, number] | null {
  const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (nonZero.length === 0) return null
  const at = (p: number) => nonZero[Math.min(nonZero.length - 1, Math.floor(p * nonZero.length))]
  return [at(0.25), at(0.5), at(0.75)]
}

export function intensityLevel(value: number, thresholds: [number, number, number] | null): number {
  if (value <= 0 || !thresholds) return 0
  if (value <= thresholds[0]) return 1
  if (value <= thresholds[1]) return 2
  if (value <= thresholds[2]) return 3
  return 4
}

/** True when every day carries a token count, so token units are meaningful. */
export function hasTokenCounts(days: HeatmapDay[]): boolean {
  return days.length > 0 && days.every((day) => typeof day.tokens === "number")
}

function buildCells(days: HeatmapDay[], now: Date, showTokens: boolean, weeks = HEATMAP_WEEKS): Cell[] {
  const dayByKey = new Map<string, HeatmapDay>()
  for (const day of days) {
    dayByKey.set(day.date, day)
  }
  const pick = (day: HeatmapDay) => (showTokens ? (day.tokens ?? 0) : day.value)
  const pickAlt = (day: HeatmapDay) => (showTokens ? day.value : day.tokens)
  const thresholds = quartileThresholds([...dayByKey.values()].map(pick))

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const start = new Date(today)
  start.setDate(start.getDate() - today.getDay() - (weeks - 1) * 7)

  const cells: Cell[] = []
  const cursor = new Date(start)
  while (cursor <= today) {
    const key = formatDayKey(cursor)
    const day = dayByKey.get(key)
    const value = day ? pick(day) : 0
    cells.push({
      key,
      date: new Date(cursor),
      value,
      altValue: day ? pickAlt(day) : undefined,
      level: intensityLevel(value, thresholds),
    })
    cursor.setDate(cursor.getDate() + 1)
  }
  return cells
}

type MonthLabel = { column: number; label: string }

function buildMonthLabels(cells: Cell[]): MonthLabel[] {
  const labels: MonthLabel[] = []
  let lastMonth = -1
  let lastLabelColumn = -99
  for (let column = 0; column * 7 < cells.length; column++) {
    const month = cells[column * 7].date.getMonth()
    if (month !== lastMonth) {
      lastMonth = month
      if (column - lastLabelColumn >= 3) {
        labels.push({ column, label: MONTH_LABELS[month] })
        lastLabelColumn = column
      }
    }
  }
  return labels
}

/**
 * "$4.21 · 3.4M tokens" — selected unit first, other unit second when the
 * plugin provides both. No date: the cell's position already says which day.
 */
function cellTitle(cell: Cell, format: ProgressFormat | null | undefined, showTokens: boolean): string {
  const primary = showTokens
    ? formatTokenCount(cell.value)
    : formatHeatmapValue(cell.value, format)
  if (cell.value <= 0) return primary

  const alt = cell.altValue
  if (alt === undefined || alt <= 0) return primary
  const secondary = showTokens ? formatHeatmapValue(alt, format) : formatTokenCount(alt)
  return `${primary} · ${secondary}`
}

/** Screen readers get the date too — they can't see which cell is hovered. */
function cellLabel(cell: Cell, format: ProgressFormat | null | undefined, showTokens: boolean): string {
  const d = cell.date
  const day = `${DOW_LABELS[d.getDay()]}, ${MONTH_LABELS[d.getMonth()]} ${d.getDate()}`
  return `${cellTitle(cell, format, showTokens)} · ${day}`
}

interface UsageHeatmapProps {
  days: HeatmapDay[]
  format?: ProgressFormat | null
  brandColor?: string
  /** Stretch FLUID_WEEKS across the card width and show a period total. */
  fluid?: boolean
}

export const FLUID_WEEKS = 26

function periodSummary(cells: Cell[], format: ProgressFormat | null | undefined, showTokens: boolean): string {
  let total = 0
  let active = 0
  for (const cell of cells) {
    if (cell.value > 0) {
      total += cell.value
      active++
    }
  }
  const totalText = showTokens
    ? formatTokenCount(total)
    : format?.kind === "dollars"
      ? `$${Math.round(total).toLocaleString("en-US")}`
      : formatHeatmapValue(total, format)
  return `${totalText} in 6 months · ${active} active day${active === 1 ? "" : "s"}`
}

function UsageHeatmapInner({ days, format, brandColor, fluid = false }: UsageHeatmapProps) {
  const isDark = useDarkMode()
  const heatmapUnit = useAppPreferencesStore((state) => state.heatmapUnit)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [tooltipPos, setTooltipPos] = useState({ left: 0, top: 0 })

  // Measure after render so the tooltip can be centered above the pointer and
  // kept inside the window. Layout effect: runs before paint, so no flicker.
  useLayoutEffect(() => {
    const el = tooltipRef.current
    if (!tooltip || !el) return
    const { width, height } = el.getBoundingClientRect()
    const maxLeft = Math.max(TOOLTIP_EDGE_PX, window.innerWidth - width - TOOLTIP_EDGE_PX)
    const above = tooltip.y - height - TOOLTIP_GAP_PX
    setTooltipPos({
      left: Math.min(Math.max(TOOLTIP_EDGE_PX, tooltip.x - width / 2), maxLeft),
      // Flip below the pointer when there is no room above.
      top: above >= TOOLTIP_EDGE_PX ? above : tooltip.y + TOOLTIP_GAP_PX + CELL_PX,
    })
  }, [tooltip])

  // Token units only apply to plugins that send token counts; everyone else
  // keeps their own unit whatever the setting says.
  const showTokens = heatmapUnit === "tokens" && hasTokenCounts(days)
  const weeks = fluid ? FLUID_WEEKS : HEATMAP_WEEKS
  const cells = useMemo(() => buildCells(days, new Date(), showTokens, weeks), [days, showTokens, weeks])
  const monthLabels = useMemo(() => buildMonthLabels(cells), [cells])

  const baseColor = adjustBrandColor(brandColor, isDark, FALLBACK_BASE_COLOR)
  const levelMix = isDark ? LEVEL_MIX_DARK : LEVEL_MIX_LIGHT

  const cellStyle = (level: number): React.CSSProperties | undefined => {
    if (level === 0) return undefined
    return { background: `color-mix(in srgb, ${baseColor} ${levelMix[level - 1]}%, var(--background))` }
  }

  const handleMouseOver = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement
    const title = target.dataset.tip
    if (title) {
      setTooltip({ x: event.clientX, y: event.clientY, text: title })
    }
  }
  const handleMouseMove = (event: React.MouseEvent) => {
    setTooltip((prev) => (prev ? { ...prev, x: event.clientX, y: event.clientY } : prev))
  }
  const handleMouseLeave = () => setTooltip(null)

  // Pad the final week column so the grid stays rectangular.
  const padCount = cells.length % 7 === 0 ? 0 : 7 - (cells.length % 7)

  const legend = (
    <div className="flex items-center gap-[3px]" aria-hidden="true">
      <span className="mr-0.5">Less</span>
      {[0, 1, 2, 3, 4].map((level) => (
        <div key={level} className="h-[9px] w-[9px] rounded-[2px] bg-muted" style={cellStyle(level)} />
      ))}
      <span className="ml-0.5">More</span>
    </div>
  )
  const tooltipEl = tooltip && (
    <div
      ref={tooltipRef}
      className="pointer-events-none fixed z-50 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md tabular-nums"
      style={{ left: tooltipPos.left, top: tooltipPos.top }}
    >
      {tooltip.text}
    </div>
  )

  if (fluid) {
    const columns = `24px repeat(${weeks}, minmax(0, 1fr))`
    const lastKey = cells[cells.length - 1]?.key
    return (
      <div className="text-muted-foreground">
        <div className="grid h-3.5 text-[9px] leading-3" style={{ gridTemplateColumns: columns, columnGap: 2 }} aria-hidden="true">
          {monthLabels.filter(({ column }) => column < weeks - 2).map(({ column, label }) => (
            <span key={column} className="whitespace-nowrap" style={{ gridColumn: column + 2, gridRow: 1 }}>
              {label}
            </span>
          ))}
        </div>
        <div
          className="grid"
          style={{ gridTemplateColumns: columns, gridTemplateRows: "repeat(7, auto)", gridAutoFlow: "column", gap: 2 }}
          onMouseOver={handleMouseOver}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {DOW_LABELS.map((label, row) => (
            <span key={label} className="flex items-center text-[9px]" aria-hidden="true">
              {row % 2 === 1 ? label : ""}
            </span>
          ))}
          {cells.map((cell) => (
            <div
              key={cell.key}
              className={`aspect-square w-full rounded-[2px] bg-muted${cell.key === lastKey ? " outline outline-[1.5px] -outline-offset-1 outline-foreground/60" : ""}`}
              style={cellStyle(cell.level)}
              data-tip={cellTitle(cell, format, showTokens)}
              aria-label={cellLabel(cell, format, showTokens)}
            />
          ))}
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px]">
          <span className="truncate tabular-nums">{periodSummary(cells, format, showTokens)}</span>
          {legend}
        </div>
        {tooltipEl}
      </div>
    )
  }

  return (
    <div className="text-muted-foreground">
      <div
        className="relative ml-[26px] h-3 text-[9px] leading-3"
        aria-hidden="true"
      >
        {monthLabels.map(({ column, label }) => (
          <span key={column} className="absolute" style={{ left: column * PITCH_PX }}>
            {label}
          </span>
        ))}
      </div>
      <div className="flex">
        <div
          className="grid w-[26px] text-[9px]"
          style={{ gridTemplateRows: `repeat(7, ${PITCH_PX}px)` }}
          aria-hidden="true"
        >
          {DOW_LABELS.map((label, row) => (
            <span key={label} className="leading-[13px]">
              {row % 2 === 1 ? label : ""}
            </span>
          ))}
        </div>
        <div
          className="grid"
          style={{
            gridAutoFlow: "column",
            gridTemplateRows: `repeat(7, ${CELL_PX}px)`,
            gridAutoColumns: `${CELL_PX}px`,
            gap: GAP_PX,
          }}
          onMouseOver={handleMouseOver}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {cells.map((cell) => (
            <div
              key={cell.key}
              className="rounded-[2.5px] bg-muted"
              style={cellStyle(cell.level)}
              data-tip={cellTitle(cell, format, showTokens)}
              aria-label={cellLabel(cell, format, showTokens)}
            />
          ))}
          {Array.from({ length: padCount }, (_, index) => (
            <div key={`pad-${index}`} className="invisible" />
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-end gap-[3px] text-[9px]" aria-hidden="true">
        <span className="mr-0.5">Less</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <div
            key={level}
            className="h-[10px] w-[10px] rounded-[2.5px] bg-muted"
            style={cellStyle(level)}
          />
        ))}
        <span className="ml-0.5">More</span>
      </div>
      {tooltip && (
        <div
          ref={tooltipRef}
          className="pointer-events-none fixed z-50 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md tabular-nums"
          style={{ left: tooltipPos.left, top: tooltipPos.top }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  )
}

export const UsageHeatmap = memo(UsageHeatmapInner)
