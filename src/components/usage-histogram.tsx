import { memo, useMemo } from "react"
import { useDarkMode } from "@/hooks/use-dark-mode"
import { adjustBrandColor } from "@/lib/color"
import { intensityLevel, quartileThresholds } from "@/components/usage-heatmap"
import type { HistogramColumns, HistogramRow } from "@/lib/plugin-types"

// Same brand mix as the heatmap so the two read as one system.
const LEVEL_MIX_LIGHT = [25, 50, 75, 100]
const LEVEL_MIX_DARK = [30, 55, 80, 100]
const FALLBACK_BASE_COLOR = "#6b7280"

const BAR_MAX_PX = 14
const BAR_MIN_PX = 2

/** Bar height in px for a bucket; zero stays a visible 2px stub. */
export function bucketHeight(value: number, max: number): number {
  if (value <= 0 || max <= 0) return BAR_MIN_PX
  return Math.max(BAR_MIN_PX, Math.round((value / max) * BAR_MAX_PX))
}

interface UsageHistogramProps {
  rows: HistogramRow[]
  columns?: HistogramColumns | null
  axis?: string | null
  brandColor?: string
}

function UsageHistogramInner({ rows, columns, axis, brandColor }: UsageHistogramProps) {
  const isDark = useDarkMode()
  const baseColor = adjustBrandColor(brandColor, isDark, FALLBACK_BASE_COLOR)
  const levelMix = isDark ? LEVEL_MIX_DARK : LEVEL_MIX_LIGHT

  // Intensity is relative to the whole block, so a quiet account looks quiet
  // next to a busy one instead of every row scaling to its own peak.
  const { thresholds, max } = useMemo(() => {
    const all = rows.flatMap((row) => row.buckets)
    return { thresholds: quartileThresholds(all), max: Math.max(0, ...all) }
  }, [rows])

  const cellStyle = (level: number): React.CSSProperties | undefined => {
    if (level === 0) return undefined
    return { background: `color-mix(in srgb, ${baseColor} ${levelMix[level - 1]}%, var(--background))` }
  }

  return (
    <div className="text-muted-foreground">
      {columns && (
        <div className="flex text-[9px] leading-3 mb-1" aria-hidden="true">
          <span className="w-[74px]" />
          <span className="w-[100px]">{columns.buckets}</span>
          <span className="w-[6px]" />
          <span className="w-[46px] text-right">{columns.value}</span>
          <span className="w-[54px] text-right">{columns.note}</span>
        </div>
      )}
      <div className="flex flex-col gap-[3px]">
        {rows.map((row, index) => (
          <div
            key={`${row.label}-${index}`}
            className="flex items-center h-[18px] text-xs tabular-nums"
            title={row.tooltip}
            aria-label={row.tooltip ? `${row.label}: ${row.tooltip}` : row.label}
          >
            <span className="w-[74px] truncate pr-1">{row.label}</span>
            <span className="w-[100px] flex items-end gap-[1px] h-[14px]" aria-hidden="true">
              {row.buckets.map((value, bucketIndex) => (
                <span
                  key={bucketIndex}
                  className="flex-1 min-w-[2px] rounded-[1px] bg-muted"
                  style={{ height: `${bucketHeight(value, max)}px`, ...cellStyle(intensityLevel(value, thresholds)) }}
                />
              ))}
            </span>
            <span className="w-[6px]" />
            <span
              className="w-[46px] text-right whitespace-nowrap text-[11px]"
              style={row.color ? { color: row.color } : undefined}
            >
              {row.value}
            </span>
            <span className="w-[54px] text-right whitespace-nowrap text-[11px]">{row.note}</span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[9px]" aria-hidden="true">
        <span className="truncate pr-2">{axis ?? ""}</span>
        <span className="flex items-center gap-[3px] flex-shrink-0">
          <span className="mr-0.5">Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              className="h-[10px] w-[10px] rounded-[2.5px] bg-muted"
              style={cellStyle(level)}
            />
          ))}
          <span className="ml-0.5">More</span>
        </span>
      </div>
    </div>
  )
}

export const UsageHistogram = memo(UsageHistogramInner)
