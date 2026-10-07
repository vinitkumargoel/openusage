import { useLayoutEffect, useRef, useState } from "react"
import { formatMoney, formatMoneyShort, formatTokensShort, niceCeiling, recentDays } from "@/lib/ledger"
import type { HeatmapDay } from "@/lib/plugin-types"
import type { HeatmapUnit } from "@/lib/settings"
import { cn } from "@/lib/utils"

const RANGES = [7, 30, 90] as const
type Range = (typeof RANGES)[number]
const RANGE_KEY = "openusage.ledger.graphRange"

const W = 328
const H = 132
const TOP = 6
const BOTTOM = 16
const RIGHT = 34
const PLOT_W = W - RIGHT
const PLOT_H = H - TOP - BOTTOM

function loadRange(): Range {
  try {
    const stored = Number(localStorage.getItem(RANGE_KEY))
    return (RANGES as readonly number[]).includes(stored) ? (stored as Range) : 30
  } catch {
    return 30
  }
}

function dayDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number)
  return new Date(y, m - 1, d)
}

const shortDate = (key: string) => dayDate(key).toLocaleDateString(undefined, { month: "short", day: "numeric" })
const longDate = (key: string) => dayDate(key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })

interface UsageBarChartProps {
  days: HeatmapDay[]
  unit: HeatmapUnit
  color: string
  now: number
}

/** Daily cost or tokens as bars, with a dashed average line. */
export function UsageBarChart({ days, unit, color, now }: UsageBarChartProps) {
  const [range, setRange] = useState<Range>(loadRange)
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [tooltipPos, setTooltipPos] = useState({ left: 0, top: 0 })

  useLayoutEffect(() => {
    const el = tooltipRef.current
    if (!hover || !el) return
    const { width, height } = el.getBoundingClientRect()
    setTooltipPos({
      left: Math.min(Math.max(6, hover.x - width / 2), window.innerWidth - width - 6),
      top: Math.max(6, hover.y - height - 10),
    })
  }, [hover])

  const series = recentDays(days, new Date(now), range)
  const values = series.map((day) => Math.max(0, unit === "tokens" ? day.tokens ?? 0 : day.value))
  const total = values.reduce((sum, v) => sum + v, 0)
  const avg = total / range
  const peak = Math.max(...values)
  const peakIndex = values.indexOf(peak)
  const ceiling = niceCeiling(peak)
  const y = (v: number) => TOP + PLOT_H * (1 - v / ceiling)
  const slot = PLOT_W / range
  const pad = range > 40 ? 0.3 : 1
  const fmtAxis = (v: number) => (unit === "tokens" ? formatTokensShort(v) : "$" + Math.round(v).toLocaleString("en-US"))
  const fmtStat = (v: number) => (unit === "tokens" ? formatTokensShort(v) : formatMoneyShort(v))
  const fmtTip = (v: number) => (v <= 0 ? "No usage" : unit === "tokens" ? `${formatTokensShort(v)} tokens` : formatMoney(v))

  const changeRange = (next: Range) => {
    setRange(next)
    try {
      localStorage.setItem(RANGE_KEY, String(next))
    } catch (error) {
      console.error("Failed to save graph range:", error)
    }
  }

  return (
    <div className="text-muted-foreground">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10.5px]">Daily {unit === "tokens" ? "tokens" : "cost"}</span>
        <div role="group" aria-label="Graph range" className="inline-flex rounded-md bg-muted p-0.5">
          {RANGES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={range === option}
              onClick={() => changeRange(option)}
              className={cn(
                "rounded-[5px] px-1.5 py-px text-[10.5px] transition-colors",
                range === option && "bg-background text-foreground shadow-sm",
              )}
            >
              {option}D
            </button>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full overflow-visible"
        role="img"
        aria-label={`Daily ${unit} for the last ${range} days. Total ${fmtStat(total)}, average ${fmtStat(avg)} per day.`}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={0} x2={PLOT_W} y1={y(ceiling * f)} y2={y(ceiling * f)} stroke="var(--border)" strokeWidth={1} />
            <text x={PLOT_W + 4} y={y(ceiling * f) + 3} fontSize={8.5} fill="currentColor" opacity={0.7}>
              {fmtAxis(ceiling * f)}
            </text>
          </g>
        ))}
        {values.map((v, i) => {
          const height = v > 0 ? Math.max(1.5, TOP + PLOT_H - y(v)) : 0
          const highlighted = hover?.index === i || i === range - 1
          return (
            <g key={series[i].date}>
              <rect
                x={i * slot + pad}
                y={TOP + PLOT_H - height}
                width={Math.max(1, slot - pad * 2)}
                height={height}
                rx={range > 40 ? 0 : 1.5}
                fill={color}
                opacity={highlighted ? 1 : 0.55}
              />
              <rect
                x={i * slot}
                y={TOP}
                width={slot}
                height={PLOT_H}
                fill="transparent"
                onMouseMove={(event) => setHover({ index: i, x: event.clientX, y: event.clientY })}
              />
            </g>
          )
        })}
        <line
          x1={0}
          x2={PLOT_W}
          y1={y(avg)}
          y2={y(avg)}
          stroke="currentColor"
          strokeOpacity={0.6}
          strokeDasharray="3 3"
          pointerEvents="none"
        />
        <text x={0} y={H - 3} fontSize={8.5} fill="currentColor" opacity={0.7}>{shortDate(series[0].date)}</text>
        <text x={PLOT_W / 2} y={H - 3} fontSize={8.5} fill="currentColor" opacity={0.7} textAnchor="middle">
          {shortDate(series[Math.floor(range / 2)].date)}
        </text>
        <text x={PLOT_W} y={H - 3} fontSize={8.5} fill="currentColor" opacity={0.7} textAnchor="end">Today</text>
      </svg>
      <div className="mt-1.5 flex justify-between text-[10.5px] tabular-nums">
        <span>Total <b className="font-semibold text-foreground">{fmtStat(total)}</b></span>
        <span>┄ Avg/day <b className="font-semibold text-foreground">{fmtStat(avg)}</b></span>
        <span title={peak > 0 ? longDate(series[peakIndex].date) : undefined}>
          Peak <b className="font-semibold text-foreground">{fmtStat(peak)}</b>
        </span>
      </div>
      {hover && (
        <div
          ref={tooltipRef}
          className="pointer-events-none fixed z-50 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md tabular-nums"
          style={{ left: tooltipPos.left, top: tooltipPos.top }}
        >
          {longDate(series[hover.index].date)} · {fmtTip(values[hover.index])}
        </div>
      )}
    </div>
  )
}
