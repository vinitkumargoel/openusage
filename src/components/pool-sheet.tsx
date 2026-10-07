import { useEffect } from "react"
import { createPortal } from "react-dom"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AccountRing, WindowBar } from "@/components/account-ring"
import { MiniBars, PoolTag } from "@/components/pool-tile"
import type { PoolAccount, PoolData, PoolWindow } from "@/lib/plugin-types"
import { TONE_TEXT, burn, elapsedPct, weeklyPace } from "@/lib/account-stats"
import { asBar, compact, ringRow, shortUntil, sum } from "@/lib/pool-stats"
import { formatCompactDuration } from "@/lib/pace-tooltip"
import { cn } from "@/lib/utils"

const dayTime = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })

function fmt(f: Intl.DateTimeFormat, iso?: string): string {
  const ms = Date.parse(iso ?? "")
  return Number.isFinite(ms) ? f.format(ms) : ""
}

function ago(now: number, iso?: string): string {
  const ms = now - Date.parse(iso ?? "")
  if (!Number.isFinite(ms)) return ""
  return ms < 60_000 ? "just now" : `${formatCompactDuration(ms)} ago`
}

function winText(now: number, w?: PoolWindow): string {
  if (!w) return "—"
  const reset = w.resetsAt ? shortUntil(now, w.resetsAt) : ""
  return `${Math.round(w.left)}% left${reset ? ` · ↻ ${reset}` : ""}`
}

interface PoolSheetProps {
  account: PoolAccount
  pool: PoolData
  max: number
  now: number
  accent: string
  onNav: (step: number) => void
  onClose: () => void
}

/** Bottom sheet with every stat for one pooled account. Esc and ←/→ work. */
export function PoolSheet({ account: a, pool, max, now, accent, onNav, onClose }: PoolSheetProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "Escape") onClose()
      else if (e.key === "ArrowRight") onNav(1)
      else if (e.key === "ArrowLeft") onNav(-1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose, onNav])

  const five = asBar("5h", a.five)
  const week = asBar("7d", a.week)
  const pace = week ? weeklyPace(week, now) : null
  const lifetime = a.ok + a.failed
  const rate = lifetime > 0 ? (a.failed / lifetime) * 100 : null
  const cohort = a.week?.resetsAt
    ? pool.cohorts.findIndex((c) => Math.abs(Date.parse(c.resetsAt) - Date.parse(a.week!.resetsAt!)) <= 3_600_000)
    : -1
  const activeModels = (a.models ?? []).filter((m) => Date.parse(m.until) > now)

  const stats: [string, string, string?][] = [
    ["Claude & GPT wk", winText(now, a.restWeek)],
    ["Claude & GPT 5h", winText(now, a.restFive)],
    [`Last ${a.requests.length * 10}m`, `${sum(a.requests)} ok · ${sum(a.failures)} failed`],
    [
      "Lifetime",
      `${compact(a.ok)} ok · ${compact(a.failed)} failed${rate !== null ? ` (${rate.toFixed(1)}%)` : ""}`,
      rate !== null && pool.errorRate !== undefined && rate > pool.errorRate * 2 ? "text-red-500" : undefined,
    ],
    ...(pool.errorRate !== undefined ? [["Pool error rate", `${pool.errorRate.toFixed(1)}%`] as [string, string]] : []),
    ...(a.cooldown ? [["Cooldown", `${a.cooldown.reason} · ${fmt(time, a.cooldown.until)}`, "text-red-500"] as [string, string, string]] : []),
    ...activeModels.map((m) => ["Model parked", `${m.model} · ${shortUntil(now, m.until)}`, "text-amber-500"] as [string, string, string]),
    ...(cohort >= 0 && pool.cohorts.length > 1 ? [["Weekly cohort", `#${cohort + 1} of ${pool.cohorts.length}`] as [string, string]] : []),
    ...(a.sampledAt ? [["Quota sampled", ago(now, a.sampledAt)] as [string, string]] : []),
    ...(a.refreshedAt ? [["Token refreshed", ago(now, a.refreshedAt)] as [string, string]] : []),
    ...(a.joinedAt ? [["In pool since", fmt(date, a.joinedAt)] as [string, string]] : []),
    ...(a.project ? [["Project", a.project] as [string, string]] : []),
    ["Auth index", a.id],
  ]

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 animate-in fade-in" style={{ "--acc": accent } as React.CSSProperties} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${a.name} details`}
        className="absolute inset-x-0 bottom-0 max-h-[92%] overflow-y-auto rounded-t-2xl bg-card px-3.5 pt-2 pb-3.5 shadow-2xl animate-in slide-in-from-bottom duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-2.5 h-1 w-9 rounded-full bg-muted" />
        <div className="flex items-center gap-2 mb-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-base font-semibold">
              <span className="truncate">{a.name}</span>
              <PoolTag account={a} />
            </div>
            <div className="text-xs text-muted-foreground truncate">{a.state === "live" ? "in rotation" : a.state}</div>
          </div>
          <Button variant="ghost" size="icon-xs" onClick={() => onNav(-1)} aria-label="Previous account"><ChevronLeft /></Button>
          <Button variant="ghost" size="icon-xs" onClick={() => onNav(1)} aria-label="Next account"><ChevronRight /></Button>
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close"><X /></Button>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-2 tabular-nums">
          {([["5h", "Gemini 5h", a.five, time], ["7d", "Gemini wk", a.week, dayTime]] as const).map(([key, title, w, f]) => (
            <div key={key} className="flex items-center gap-2 rounded-xl bg-muted/60 p-2">
              <AccountRing row={ringRow({ five: key === "5h" ? a.five : undefined, week: key === "7d" ? a.week : undefined })} only={key} size={40} showLabel={false} />
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
                <div className="text-[13px] font-semibold">{w ? `${Math.round(w.left)}% left` : "None"}</div>
                <div className="truncate text-[10.5px] text-muted-foreground">{w?.resetsAt ? fmt(f, w.resetsAt) : key === "5h" ? "no 5h bucket" : ""}</div>
              </div>
            </div>
          ))}
        </div>

        {five && (
          <Block title="5h window">
            <WindowBar used={five.used} elapsed={elapsedPct(five, now)} label="Gemini 5 hour window" />
            <p>
              {Math.round(elapsedPct(five, now) ?? 0)}% gone, <b>{Math.round(five.used)}%</b> used ·{" "}
              <span className={TONE_TEXT[burn(five, now).tone]}>{burn(five, now).text}</span>
            </p>
          </Block>
        )}
        {week && pace && (
          <Block title="Weekly pace">
            <WindowBar used={week.used} elapsed={elapsedPct(week, now)} marker={pace.expected} label="Gemini weekly window" />
            <p>
              <b className={pace.delta >= 0 ? "text-green-500" : "text-red-500"}>{pace.text}</b> · even spend {Math.round(pace.expected)}% by now
            </p>
          </Block>
        )}
        {a.requests.length > 0 && (
          <Block title={`Requests · last ${Math.floor((a.requests.length * 10) / 60)}h ${(a.requests.length * 10) % 60}m`}>
            <MiniBars requests={a.requests} failures={a.failures} max={max} height={48} slots={pool.slots} />
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
              <span>{pool.slots[0]?.split("-")[0]}</span>
              <span>relay time</span>
              <span>{pool.slots[pool.slots.length - 1]?.split("-")[1]}</span>
            </div>
          </Block>
        )}

        <Block>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs tabular-nums">
            {stats.map(([label, value, cls]) => (
              <div key={label + value} className="contents">
                <dt className="text-muted-foreground whitespace-nowrap">{label}</dt>
                <dd className={cn("text-right truncate", cls)} title={value}>{value}</dd>
              </div>
            ))}
          </dl>
        </Block>
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
