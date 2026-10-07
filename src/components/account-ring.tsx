import type { AccountRow } from "@/lib/plugin-types"
import { TONE_TEXT, barOf, headroom, usedTone } from "@/lib/account-stats"
import { cn } from "@/lib/utils"

function Arc({ left, size, stroke, r, used }: { left: number; size: number; stroke: number; r: number; used: number }) {
  const c = 2 * Math.PI * r
  const mid = size / 2
  return (
    <g className={TONE_TEXT[usedTone(used)]}>
      <circle cx={mid} cy={mid} r={r} fill="none" className="stroke-muted" strokeWidth={stroke} />
      <circle
        cx={mid}
        cy={mid}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - left / 100)}
        transform={`rotate(-90 ${mid} ${mid})`}
        style={{ transition: "stroke-dashoffset 0.5s" }}
      />
    </g>
  )
}

/**
 * Battery ring: outer arc is 5h left, inner arc 7d left, center headroom.
 * `only` draws a single window (used by the detail sheet).
 */
export function AccountRing({
  row,
  size = 54,
  only,
  showLabel = true,
}: {
  row: AccountRow
  size?: number
  only?: string
  showLabel?: boolean
}) {
  const outerW = size * 0.09
  const innerW = size * 0.065
  const outerR = (size - outerW) / 2
  const innerR = outerR - outerW - 2.5
  const dim = row.flag === "expired"
  const outer = barOf(row, only ?? "5h")
  const inner = only ? undefined : barOf(row, "7d")
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="flex-none">
      {outer ? (
        <Arc left={dim ? 0 : 100 - outer.used} size={size} stroke={outerW} r={outerR} used={outer.used} />
      ) : (
        <circle cx={size / 2} cy={size / 2} r={outerR} fill="none" className="stroke-muted" strokeWidth={outerW / 2} strokeDasharray="3 4" />
      )}
      {inner && <Arc left={dim ? 0 : 100 - inner.used} size={size} stroke={innerW} r={innerR} used={inner.used} />}
      {showLabel && (
        <>
          <text
            x="50%"
            y={size / 2 - 1}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={size * 0.27}
            fontWeight={700}
            className="fill-foreground tabular-nums"
          >
            {dim ? "–" : headroom(row)}
          </text>
          {!dim && (
            <text x="50%" y={size / 2 + size * 0.2} textAnchor="middle" fontSize={size * 0.13} className="fill-muted-foreground">
              % left
            </text>
          )}
        </>
      )}
    </svg>
  )
}

/** Usage fill over a striped "time gone" track, with an optional pace marker. */
export function WindowBar({ used, elapsed, marker, label }: { used: number; elapsed: number | null; marker?: number; label: string }) {
  return (
    <div className="relative h-[7px] rounded-full bg-muted overflow-hidden" role="img" aria-label={label}>
      {elapsed !== null && (
        <span
          className="absolute inset-y-0 left-0 bg-[repeating-linear-gradient(135deg,var(--color-border)_0_3px,transparent_3px_6px)]"
          style={{ width: `${elapsed}%` }}
        />
      )}
      <span
        className={cn("absolute inset-y-0 left-0 rounded-full bg-current transition-[width] duration-500", TONE_TEXT[usedTone(used)])}
        style={{ width: `${used}%` }}
      />
      {marker !== undefined && (
        <span className="absolute -inset-y-0.5 w-0.5 rounded-sm bg-foreground/60" style={{ left: `calc(${marker}% - 1px)` }} />
      )}
    </div>
  )
}
