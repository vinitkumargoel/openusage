import { forwardRef } from "react"
import { Loader2 } from "lucide-react"
import { AccountRing, WindowBar } from "@/components/account-ring"
import type { AccountRow } from "@/lib/plugin-types"
import { TONE_TEXT, barOf, burn, domainOf, elapsedPct, until, weeklyPace } from "@/lib/account-stats"
import { cn } from "@/lib/utils"

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })

/** active / limit / expired / off / best — one tag, most important first. */
export function AccountTag({ row, isBest }: { row: AccountRow; isBest: boolean }) {
  if (row.active) return <span className="shrink-0 rounded-full px-1.5 text-[10px] font-semibold bg-[var(--acc)] text-white">active</span>
  if (row.flag) return <span className="shrink-0 rounded-full px-1.5 text-[10px] font-semibold bg-red-500/15 text-red-500">{row.flag}</span>
  if (isBest) return <span className="shrink-0 rounded-full px-1.5 text-[10px] font-semibold bg-green-500/15 text-green-500">best</span>
  return null
}

export function Slot({ row, size = 18 }: { row: AccountRow; size?: number }) {
  return (
    <span
      className={cn("flex-none grid place-items-center rounded-full font-semibold", row.active ? "bg-[var(--acc)] text-white" : "bg-muted text-muted-foreground")}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
    >
      {row.id}
    </span>
  )
}

interface TileProps {
  row: AccountRow
  isBest: boolean
  now: number
  pending: string | null
  onOpen: () => void
  onSwitch: () => void
}

export const AccountTile = forwardRef<HTMLDivElement, TileProps>(function AccountTile(
  { row, isBest, now, pending, onOpen, onSwitch },
  ref
) {
  const five = barOf(row, "5h")
  const week = barOf(row, "7d")
  const b = five ? burn(five, now) : null
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={`${row.name} details`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-xl border border-transparent bg-muted/50 p-2 pb-1.5 cursor-pointer transition-colors hover:bg-muted hover:border-border focus-visible:outline-2 focus-visible:outline-[var(--acc)]",
        isBest && "border-green-500/40",
        row.flag === "limit" && "border-red-500/40",
        row.flag === "expired" && "opacity-60"
      )}
    >
      <div className="flex items-center gap-1 min-w-0">
        <span className="flex-1 min-w-0 truncate text-[12.5px] font-semibold" title={row.detail}>{row.name}</span>
        <AccountTag row={row} isBest={isBest} />
      </div>
      <div className="flex items-center gap-2 min-w-0">
        <AccountRing row={row} size={46} />
        <div className="min-w-0 whitespace-nowrap text-[10.5px] leading-[1.55] text-muted-foreground tabular-nums">
          {five && (
            <div>
              5h <b className="font-semibold text-foreground">{Math.round(five.used)}%</b>
            </div>
          )}
          {week ? (
            <div>
              7d <b className="font-semibold text-foreground">{Math.round(week.used)}%</b>
            </div>
          ) : (
            <div className="opacity-60">no 7d</div>
          )}
          <div className={cn("truncate", row.flag === "expired" ? "text-red-500" : b ? TONE_TEXT[b.tone] : "")} title={b?.text}>
            {row.flag === "expired" ? "expired" : b?.short}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-1 border-t pt-1.5 text-[10.5px] text-muted-foreground tabular-nums">
        <span className="truncate" title={five?.resetsAt ? `#${row.id} · 5h resets in ${until(now, five.resetsAt)}` : `#${row.id}`}>
          #{row.id}
          {five?.resetsAt && <> · ↻ {until(now, five.resetsAt)}</>}
        </span>
        {!row.active && (
          <button
            type="button"
            className="flex-none rounded-md px-1 py-0.5 -my-0.5 text-[11px] font-semibold text-[var(--acc)] hover:bg-[var(--acc)]/10 disabled:opacity-40"
            disabled={pending !== null}
            aria-label={`Switch to ${row.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onSwitch()
            }}
          >
            {pending === row.id ? <Loader2 className="size-3 animate-spin" /> : "Switch"}
          </button>
        )}
      </div>
    </div>
  )
})

/** The active account, big: ring, session window with burn pace, weekly pace. */
export function ActiveHero({ row, now, onOpen }: { row: AccountRow; now: number; onOpen: () => void }) {
  const five = barOf(row, "5h")
  const week = barOf(row, "7d")
  const b = five ? burn(five, now) : null
  const pace = week ? weeklyPace(week, now) : null
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${row.name} details`}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className="mb-2.5 cursor-pointer rounded-2xl border bg-[linear-gradient(180deg,color-mix(in_srgb,var(--acc)_12%,transparent),transparent_140%)] p-3"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Slot row={row} size={24} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{row.name}</div>
          <div className="text-[11px] text-muted-foreground truncate">{domainOf(row)} · slot #{row.id}</div>
        </div>
        <AccountTag row={row} isBest={false} />
      </div>
      <div className="mt-2.5 grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2.5">
        <AccountRing row={row} size={64} />
        <div className="min-w-0 text-[11px] text-muted-foreground tabular-nums">
          {five && (
            <>
              <div className="mb-1 flex justify-between gap-2">
                <span className="whitespace-nowrap">Session <b className="text-foreground">{Math.round(five.used)}%</b></span>
                {five.resetsAt && <span className="whitespace-nowrap" title={`Resets ${time.format(Date.parse(five.resetsAt))}`}>↻ {until(now, five.resetsAt)}</span>}
              </div>
              <WindowBar used={five.used} elapsed={elapsedPct(five, now)} label="5 hour window" />
              {b && <div className={cn("mt-0.5 truncate text-[10.5px]", TONE_TEXT[b.tone])}>{b.text}</div>}
            </>
          )}
          {week ? (
            <>
              <div className="mt-2 mb-1 flex justify-between gap-2">
                <span className="whitespace-nowrap">Weekly <b className="text-foreground">{Math.round(week.used)}%</b></span>
                <span className="whitespace-nowrap">↻ {until(now, week.resetsAt)}</span>
              </div>
              <WindowBar used={week.used} elapsed={elapsedPct(week, now)} marker={pace?.expected} label="7 day window" />
              {pace && <div className={cn("mt-0.5 text-[10.5px]", pace.delta >= 0 ? "text-green-500" : "text-red-500")}>{pace.text}</div>}
            </>
          ) : (
            <div className="mt-2 text-[10.5px] opacity-60">No weekly limit</div>
          )}
        </div>
      </div>
    </div>
  )
}
