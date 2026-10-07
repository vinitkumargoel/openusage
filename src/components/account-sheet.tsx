import { useEffect } from "react"
import { createPortal } from "react-dom"
import { ChevronLeft, ChevronRight, Copy, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AccountRing, WindowBar } from "@/components/account-ring"
import { AccountTag } from "@/components/account-tile"
import type { AccountRow } from "@/lib/plugin-types"
import { TONE_TEXT, barOf, burn, elapsedPct, headroom, until, usedTone, weeklyPace } from "@/lib/account-stats"
import { cn } from "@/lib/utils"

const dayTime = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })

interface AccountSheetProps {
  row: AccountRow
  isBest: boolean
  now: number
  pending: string | null
  onSwitch: (id: string) => void
  onNav: (step: number) => void
  onClose: () => void
}

/** Bottom sheet with every stat for one account. Esc, ←/→ and S work. */
export function AccountSheet({ row, isBest, now, pending, onSwitch, onNav, onClose }: AccountSheetProps) {
  const five = barOf(row, "5h")
  const week = barOf(row, "7d")
  const pace = week ? weeklyPace(week, now) : null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "Escape") onClose()
      else if (e.key === "ArrowRight") onNav(1)
      else if (e.key === "ArrowLeft") onNav(-1)
      else if (e.key.toLowerCase() === "s" && !row.active) onSwitch(row.id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [row, onClose, onNav, onSwitch])

  const copy = () => {
    navigator.clipboard.writeText(`cswap switch ${row.id}`).catch((err) => console.error("Copy failed:", err))
  }

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 animate-in fade-in" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${row.name} details`}
        className="absolute inset-x-0 bottom-0 max-h-[92%] overflow-y-auto rounded-t-2xl bg-card px-3.5 pt-2 pb-3.5 shadow-2xl animate-in slide-in-from-bottom duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-2.5 h-1 w-9 rounded-full bg-muted" />
        <div className="flex items-center gap-2 mb-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-base font-semibold">
              <span className="truncate">{row.name}</span>
              <AccountTag row={row} isBest={isBest} />
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {row.detail} · slot #{row.id}
            </div>
          </div>
          <Button variant="ghost" size="icon-xs" onClick={() => onNav(-1)} aria-label="Previous account"><ChevronLeft /></Button>
          <Button variant="ghost" size="icon-xs" onClick={() => onNav(1)} aria-label="Next account"><ChevronRight /></Button>
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close"><X /></Button>
        </div>

        {row.flag === "expired" && (
          <div className="mb-2 rounded-xl bg-muted/60 p-2.5 text-xs text-red-500">
            Login expired. Run <code>claude</code> as this account, then <code>cswap add</code>.
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 mb-2 tabular-nums">
          {[["5h", "5 hour", five, time], ["7d", "7 day", week, dayTime]].map(([key, title, bar, fmt]) => {
            const b = bar as typeof five
            return (
              <div key={key as string} className="flex items-center gap-2.5 rounded-xl bg-muted/60 p-2.5">
                <AccountRing row={row} only={key as string} size={46} showLabel={false} />
                <div className="min-w-0">
                  <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{title as string}</div>
                  {b ? (
                    <>
                      <div className="text-sm font-semibold">{Math.round(100 - b.used)}% left</div>
                      {b.resetsAt && (
                        <div className="text-[10.5px] text-muted-foreground">
                          {(fmt as Intl.DateTimeFormat).format(Date.parse(b.resetsAt))} · {until(now, b.resetsAt)}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="text-sm font-semibold text-muted-foreground">None</div>
                      <div className="text-[10.5px] text-muted-foreground">not on this plan</div>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {five && (
          <Block title="Session window">
            <WindowBar used={five.used} elapsed={elapsedPct(five, now)} label="5 hour window" />
            <p>
              {Math.round(elapsedPct(five, now) ?? 0)}% of the window gone, <b>{Math.round(five.used)}%</b> used ·{" "}
              <span className={TONE_TEXT[burn(five, now).tone]}>{burn(five, now).text}</span>
            </p>
          </Block>
        )}
        {week && pace && (
          <Block title="Weekly pace">
            <WindowBar used={week.used} elapsed={elapsedPct(week, now)} marker={pace.expected} label="7 day window" />
            <p>
              <b className={pace.delta >= 0 ? "text-green-500" : "text-red-500"}>{pace.text}</b> · expected{" "}
              {pace.expected.toFixed(1)}% by now
              {week.emptyAt && (
                <>
                  <br />
                  {week.lasts ? "Lasts to reset" : "Runs out before reset"} · empty ~{dayTime.format(Date.parse(week.emptyAt))}
                </>
              )}
            </p>
          </Block>
        )}

        <Block>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs tabular-nums">
            <dt className="text-muted-foreground">Headroom</dt>
            <dd className={cn("text-right font-semibold", TONE_TEXT[usedTone(100 - headroom(row))])}>
              {headroom(row)}%{isBest ? " · best pick" : ""}
            </dd>
            {row.stats?.map((s) => (
              <div key={s.label} className="contents">
                <dt className="text-muted-foreground">{s.label}</dt>
                <dd className="text-right truncate" title={s.value}>{s.value}</dd>
              </div>
            ))}
          </dl>
        </Block>

        <div className="flex gap-2 mt-3">
          <Button variant="outline" size="sm" className="flex-1" onClick={copy} aria-label="Copy cswap command">
            <Copy /> cswap switch {row.id}
          </Button>
          <Button size="sm" className="flex-[1.4]" disabled={row.active || pending !== null} onClick={() => onSwitch(row.id)}>
            {row.active ? "Active now" : pending === row.id ? <Loader2 className="animate-spin" /> : `Switch to ${row.name}`}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function Block({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 rounded-xl bg-muted/60 p-2.5 text-xs [&_p]:mt-1.5 [&_p]:text-muted-foreground [&_b]:text-foreground">
      {title && <h4 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>}
      {children}
    </div>
  )
}
