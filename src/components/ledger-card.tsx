import { useState, type ReactNode } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { hasTokenCounts, UsageHeatmap } from "@/components/usage-heatmap"
import { UsageBarChart } from "@/components/usage-bar-chart"
import { useDarkMode } from "@/hooks/use-dark-mode"
import { adjustBrandColor, FALLBACK_BASE_COLOR } from "@/lib/color"
import { formatMoney, formatTokensShort, splitLedgerLines, usageSummary, type UsageTotals } from "@/lib/ledger"
import { calculatePaceStatus } from "@/lib/pace-status"
import { formatRunsOutText } from "@/lib/pace-tooltip"
import type { MetricLine } from "@/lib/plugin-types"
import { formatResetAbsoluteLabel, formatResetRelativeLabel, formatResetTooltipText } from "@/lib/reset-tooltip"
import { saveHeatmapUnit, type DisplayMode, type HeatmapUnit, type ResetTimerDisplayMode, type TimeFormatMode } from "@/lib/settings"
import { clamp01, cn, formatCountNumber } from "@/lib/utils"
import { useAppPreferencesStore } from "@/stores/app-preferences-store"

type ProgressLine = Extract<MetricLine, { type: "progress" }>

type LedgerCardProps = {
  lines: MetricLine[]
  brandColor?: string
  displayMode: DisplayMode
  resetTimerDisplayMode: ResetTimerDisplayMode
  timeFormatMode: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
  now: number
  /** Renders a line the ledger has no special layout for (badges, notes). */
  renderLine: (line: MetricLine, key: string) => ReactNode
}

type ActivityView = "heatmap" | "graph"
const ACTIVITY_VIEW_KEY = "openusage.ledger.activityView"

function loadActivityView(): ActivityView {
  try {
    return localStorage.getItem(ACTIVITY_VIEW_KEY) === "graph" ? "graph" : "heatmap"
  } catch {
    return "heatmap"
  }
}

type Pace = {
  kind: "under" | "on" | "over" | "maxed" | null
  /** Fraction of the period gone, 0-1; null without a reset time. */
  elapsed: number | null
  runsOutText: string | null
}

function paceOf(line: ProgressLine, now: number): Pace {
  const resetsAtMs = line.resetsAt ? Date.parse(line.resetsAt) : Number.NaN
  const period = line.periodDurationMs
  if (line.used >= line.limit) return { kind: "maxed", elapsed: null, runsOutText: null }
  if (!Number.isFinite(resetsAtMs) || !period || period <= 0) return { kind: null, elapsed: null, runsOutText: null }
  const elapsed = clamp01((now - (resetsAtMs - period)) / period)
  const result = calculatePaceStatus(line.used, line.limit, resetsAtMs, period, now)
  if (!result) return { kind: null, elapsed, runsOutText: null }
  const kind = result.status === "ahead" ? "under" : result.status === "on-track" ? "on" : "over"
  const runsOutText = formatRunsOutText({
    paceResult: result, used: line.used, limit: line.limit, periodDurationMs: period, resetsAtMs, nowMs: now,
  })
  return { kind, elapsed, runsOutText }
}

const PACE_LABEL = { under: "Under pace", on: "On pace", over: "Over pace", maxed: "Maxed" } as const
const PACE_COLOR = {
  under: "text-green-500",
  on: "text-muted-foreground",
  over: "text-red-500",
  maxed: "text-red-500",
} as const

function SectionTitle({ children }: { children: ReactNode }) {
  return <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/80">{children}</span>
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-[5px] px-1.5 py-px text-[10.5px] text-muted-foreground transition-colors",
            value === option.value && "bg-background text-foreground shadow-sm",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function shownPercent(line: ProgressLine, displayMode: DisplayMode) {
  const amount = displayMode === "used" ? line.used : Math.max(0, line.limit - line.used)
  return clamp01(amount / line.limit) * 100
}

function ResetLabel({ line, now, mode, timeFormatMode, onToggle }: {
  line: ProgressLine
  now: number
  mode: ResetTimerDisplayMode
  timeFormatMode: TimeFormatMode
  onToggle?: () => void
}) {
  if (!line.resetsAt) return null
  const text = mode === "absolute"
    ? formatResetAbsoluteLabel(now, line.resetsAt, timeFormatMode)
    : formatResetRelativeLabel(now, line.resetsAt)
  if (!text) return null
  const tooltip = formatResetTooltipText({ nowMs: now, resetsAtIso: line.resetsAt, visibleMode: mode, timeFormatMode })
  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <button
            {...props}
            type="button"
            onClick={onToggle}
            disabled={!onToggle}
            className="block max-w-full truncate text-left tabular-nums hover:text-foreground transition-colors"
          >
            {text}
          </button>
        )}
      />
      {tooltip && <TooltipContent side="top">{tooltip}</TooltipContent>}
    </Tooltip>
  )
}

function LimitTile({ line, color, props }: { line: ProgressLine; color: string; props: LedgerCardProps }) {
  const { displayMode, now } = props
  const pace = paceOf(line, now)
  const percent = shownPercent(line, displayMode)
  const maxed = pace.kind === "maxed"
  const marker = pace.elapsed !== null && !maxed
    ? (displayMode === "used" ? pace.elapsed : 1 - pace.elapsed) * 100
    : null
  const outcome = maxed
    ? <span className="font-medium text-red-500">Blocked until reset</span>
    : pace.runsOutText
      ? <span className="font-medium text-red-500">{pace.runsOutText}</span>
      : pace.kind
        ? <span className="text-muted-foreground/70">Lasts until reset</span>
        : <span>&nbsp;</span>

  return (
    <div className="min-w-0 rounded-lg bg-muted/60 px-2.5 py-2">
      <div className="flex items-center justify-between gap-1 text-xs text-muted-foreground">
        <span className="truncate">{line.label}</span>
        {pace.kind && (
          <span className={cn("flex items-center gap-1 whitespace-nowrap text-[10px] font-semibold", PACE_COLOR[pace.kind])}>
            <span className="inline-block size-1.5 rounded-full bg-current" aria-hidden="true" />
            {PACE_LABEL[pace.kind]}
          </span>
        )}
      </div>
      <div className={cn("mt-0.5 text-2xl font-semibold leading-tight tracking-tight tabular-nums", maxed && "text-red-500")}>
        {Math.round(percent)}
        <span className="text-sm font-normal text-muted-foreground">%{displayMode === "left" ? " left" : ""}</span>
      </div>
      <div
        className="relative my-1.5 h-1 rounded-full bg-foreground/10"
        role="progressbar"
        aria-label={line.label}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${percent}%`, background: maxed ? "var(--red-500)" : color }}
        />
        {marker !== null && (
          <div
            className="absolute -inset-y-[3px] w-0.5 -translate-x-1/2 bg-foreground/50"
            style={{ left: `${marker}%` }}
            title={`${Math.round((pace.elapsed ?? 0) * 100)}% of the period gone`}
          />
        )}
      </div>
      <div className="flex flex-col text-[10.5px] text-muted-foreground">
        <ResetLabel
          line={line}
          now={now}
          mode={props.resetTimerDisplayMode}
          timeFormatMode={props.timeFormatMode}
          onToggle={props.onResetTimerDisplayModeToggle}
        />
        {outcome}
      </div>
    </div>
  )
}

function rowValue(line: ProgressLine, displayMode: DisplayMode): ReactNode {
  const left = Math.max(0, line.limit - line.used)
  if (line.format.kind === "percent") {
    return `${Math.round(shownPercent(line, displayMode))}%${displayMode === "left" ? " left" : ""}`
  }
  const fmt = (v: number) =>
    line.format.kind === "dollars" ? formatMoney(v) : `${formatCountNumber(v)} ${line.format.kind === "count" ? line.format.suffix : ""}`.trim()
  if (displayMode === "left") return `${fmt(left)} left`
  return (
    <>
      {fmt(line.used)} <span className="text-muted-foreground/70">/ {line.format.kind === "dollars" ? "$" + formatCountNumber(line.limit) : fmt(line.limit)}</span>
    </>
  )
}

function LimitsTable({ rows, color, props }: { rows: ProgressLine[]; color: string; props: LedgerCardProps }) {
  return (
    <div className="grid grid-cols-[auto_1fr_auto_8px] items-center gap-x-2.5 gap-y-1.5 text-xs">
      {rows.map((line) => {
        const pace = paceOf(line, props.now)
        const percent = shownPercent(line, props.displayMode)
        const alert = pace.kind === "over" || pace.kind === "maxed"
        return (
          <div key={line.label} className="contents">
            <span className="truncate">{line.label}</span>
            <div className="relative h-1 rounded-full bg-muted" aria-hidden="true">
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{
                  width: `${percent}%`,
                  background: pace.kind === "maxed" ? "var(--red-500)" : line.format.kind === "dollars" ? "var(--yellow-500)" : color,
                }}
              />
            </div>
            <span className="whitespace-nowrap text-right tabular-nums">{rowValue(line, props.displayMode)}</span>
            <span
              className={cn("size-2 rounded-full", alert ? "bg-red-500" : "bg-transparent")}
              title={alert ? (pace.kind === "maxed" ? "Limit reached" : pace.runsOutText ?? "Over pace") : undefined}
              aria-label={alert ? (pace.kind === "maxed" ? "Limit reached" : "Over pace") : undefined}
            />
          </div>
        )
      })}
    </div>
  )
}

function UsageCell({ label, totals, unit }: { label: string; totals: UsageTotals; unit: HeatmapUnit }) {
  const empty = totals.cost <= 0 && totals.tokens <= 0
  const primary = unit === "tokens" ? formatTokensShort(totals.tokens) : formatMoney(totals.cost)
  const secondary = unit === "tokens" ? formatMoney(totals.cost) : `${formatTokensShort(totals.tokens)} tok`
  return (
    <div className="min-w-0 px-2.5 py-2">
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div className="truncate text-[15px] font-semibold tabular-nums">{empty ? "—" : primary}</div>
      <div className="truncate text-[10.5px] text-muted-foreground/70 tabular-nums">{empty ? "no usage" : secondary}</div>
    </div>
  )
}

export function LedgerCard(props: LedgerCardProps) {
  const isDark = useDarkMode()
  const heatmapUnit = useAppPreferencesStore((state) => state.heatmapUnit)
  const setHeatmapUnit = useAppPreferencesStore((state) => state.setHeatmapUnit)
  const [activityView, setActivityView] = useState<ActivityView>(loadActivityView)

  const parts = splitLedgerLines(props.lines)
  const color = adjustBrandColor(props.brandColor, isDark, FALLBACK_BASE_COLOR)
  const days = parts.heatmap?.days ?? []
  const tokensAvailable = hasTokenCounts(days)
  const unit: HeatmapUnit = tokensAvailable ? heatmapUnit : "cost"
  const summary = parts.heatmap ? usageSummary(days, new Date(props.now)) : null

  const changeUnit = (next: HeatmapUnit) => {
    setHeatmapUnit(next)
    void saveHeatmapUnit(next).catch((error) => {
      console.error("Failed to save heatmap unit:", error)
    })
  }
  const changeView = (next: ActivityView) => {
    setActivityView(next)
    try {
      localStorage.setItem(ACTIVITY_VIEW_KEY, next)
    } catch (error) {
      console.error("Failed to save activity view:", error)
    }
  }

  return (
    <div className="space-y-3.5">
      {parts.before.length > 0 && (
        <div className="space-y-1">{parts.before.map((line, i) => props.renderLine(line, `before-${i}`))}</div>
      )}

      {parts.tiles.length > 0 && (
        <div className={cn("grid gap-2.5", parts.tiles.length > 1 && "grid-cols-2")}>
          {parts.tiles.map((line) => <LimitTile key={line.label} line={line} color={color} props={props} />)}
        </div>
      )}

      {parts.rows.length > 0 && (
        <div>
          <div className="mb-2"><SectionTitle>Limits</SectionTitle></div>
          <LimitsTable rows={parts.rows} color={color} props={props} />
        </div>
      )}

      {summary && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <SectionTitle>Usage</SectionTitle>
            {tokensAvailable && (
              <Segmented
                label="Usage unit"
                value={unit}
                onChange={changeUnit}
                options={[{ value: "cost", label: "Cost" }, { value: "tokens", label: "Tokens" }]}
              />
            )}
          </div>
          <div className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border">
            <UsageCell label="Today" totals={summary.today} unit={unit} />
            <UsageCell label="Yesterday" totals={summary.yesterday} unit={unit} />
            <UsageCell label="30 days" totals={summary.last30} unit={unit} />
          </div>
        </div>
      )}

      {parts.heatmap && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <SectionTitle>Activity</SectionTitle>
            <Segmented
              label="Activity view"
              value={activityView}
              onChange={changeView}
              options={[{ value: "heatmap", label: "Heatmap" }, { value: "graph", label: "Graph" }]}
            />
          </div>
          {activityView === "heatmap" ? (
            <UsageHeatmap days={days} format={parts.heatmap.format} brandColor={parts.heatmap.color ?? props.brandColor} fluid />
          ) : (
            <UsageBarChart days={days} unit={unit} color={color} now={props.now} />
          )}
        </div>
      )}

      {parts.after.length > 0 && (
        <div className="space-y-1">{parts.after.map((line, i) => props.renderLine(line, `after-${i}`))}</div>
      )}
    </div>
  )
}
