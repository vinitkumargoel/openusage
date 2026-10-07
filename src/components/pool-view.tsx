import { useCallback, useState } from "react"
import { ArrowUpDown } from "lucide-react"
import { AccountRing, WindowBar } from "@/components/account-ring"
import { useTileMotion } from "@/components/account-list"
import { PoolSheet } from "@/components/pool-sheet"
import { PoolTile } from "@/components/pool-tile"
import type { PoolData } from "@/lib/plugin-types"
import { TONE_TEXT, burn, elapsedPct, weeklyPace } from "@/lib/account-stats"
import { POOL_FILTERS, POOL_SORTS, asBar, firstDry, ringRow, shortUntil, type PoolFilterKey, type PoolSortKey } from "@/lib/pool-stats"
import { formatCompactDuration } from "@/lib/pace-tooltip"
import { cn } from "@/lib/utils"

const dayTime = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
const STATE_BG = { live: "bg-green-500", cooling: "bg-red-500", offline: "bg-red-500", sampling: "bg-muted-foreground/40" }

interface PoolViewProps {
  pool: PoolData
  now: number
  /** Brand color for request bars and accents. */
  accent?: string
}

/** Detail page for accounts pooled behind a relay: summary card, KPIs, one tile per account. */
export function PoolView({ pool, now, accent = "#4285F4" }: PoolViewProps) {
  const [filter, setFilter] = useState<PoolFilterKey>("all")
  const [sort, setSort] = useState<PoolSortKey>("driest")
  const [openId, setOpenId] = useState<string | null>(null)
  const tileRef = useTileMotion()

  const cmp = POOL_SORTS[sort].cmp
  const tiles = pool.accounts.filter(POOL_FILTERS[filter].test)
  if (cmp) tiles.sort(cmp)
  const open = openId ? pool.accounts.find((a) => a.id === openId) : undefined
  const max = Math.max(1, ...pool.accounts.flatMap((a) => a.requests.map((r, i) => r + (a.failures[i] ?? 0))))
  const sortKeys = Object.keys(POOL_SORTS) as PoolSortKey[]

  const nav = useCallback(
    (step: number) => {
      if (tiles.length === 0) return
      const i = tiles.findIndex((a) => a.id === openId)
      setOpenId(tiles[(i + step + tiles.length) % tiles.length].id)
    },
    [tiles, openId]
  )
  const close = useCallback(() => setOpenId(null), [])

  const { counts } = pool
  const nextCohort = pool.cohorts
    .filter((c) => Date.parse(c.resetsAt) > now)
    .sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt))[0]

  return (
    <div style={{ "--acc": accent } as React.CSSProperties}>
      <PoolHero pool={pool} now={now} />

      <div className="mb-2.5 grid grid-cols-3 gap-1.5 tabular-nums">
        <Kpi
          value={<>{counts.live}<small className="text-[11px] font-medium text-muted-foreground">/{counts.total}</small></>}
          label="live"
          valueClass={counts.live === counts.total ? "text-green-500" : undefined}
          title={`${counts.live} live · ${counts.cooling} cooling · ${counts.offline} offline · ${counts.sampled} sampled${counts.unreachable ? ` · ${counts.unreachable} unreachable` : ""}`}
        >
          {pool.accounts.map((a) => (
            <i key={a.id} title={`${a.name}: ${a.state}`} className={cn("h-1 flex-1 rounded-sm", STATE_BG[a.state])} />
          ))}
        </Kpi>
        <Kpi
          value={pool.errorRate !== undefined ? <>{pool.errorRate.toFixed(1)}<small className="text-[11px] font-medium text-muted-foreground">%</small></> : "—"}
          label="errors"
          valueClass={pool.errorRate !== undefined && pool.errorRate >= 5 ? "text-red-500" : pool.errorRate !== undefined && pool.errorRate >= 2 ? "text-amber-500" : undefined}
          title={pool.worstRate !== undefined ? `worst account ${pool.worstRate.toFixed(1)}%` : undefined}
        >
          {pool.accounts.map((a) => {
            const total = a.ok + a.failed
            const rate = total > 0 ? (a.failed / total) * 100 : 0
            return <i key={a.id} className={cn("h-1 flex-1 rounded-sm", rate > (pool.errorRate ?? 0) * 2 && rate > 0 ? "bg-red-500" : "bg-muted")} />
          })}
        </Kpi>
        <Kpi
          value={nextCohort ? shortUntil(now, nextCohort.resetsAt) : "—"}
          label={pool.cohorts.length > 1 ? `${pool.cohorts.length} refill wk` : "weekly refill"}
          title={nextCohort ? `${nextCohort.count} accounts refill ${dayTime.format(Date.parse(nextCohort.resetsAt))}` : undefined}
        >
          {pool.cohorts.map((c) => (
            <i key={c.resetsAt} className="h-1 flex-1 rounded-sm bg-[var(--acc)]" style={{ opacity: 0.35 + (1 - c.left / 100) * 0.65 }} />
          ))}
        </Kpi>
      </div>

      <div className="mb-2 flex items-center gap-1.5">
        <div className="flex min-w-0 gap-1 overflow-x-auto [scrollbar-width:none]">
          {(Object.keys(POOL_FILTERS) as PoolFilterKey[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              aria-pressed={filter === k}
              className={cn(
                "whitespace-nowrap rounded-full border px-1.5 py-px text-[11px]",
                filter === k ? "border-foreground bg-foreground text-background" : "text-muted-foreground"
              )}
            >
              {POOL_FILTERS[k].label}
              <span className="ml-1 opacity-60">{pool.accounts.filter(POOL_FILTERS[k].test).length}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ml-auto flex flex-none items-center gap-1 whitespace-nowrap rounded-md px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setSort(sortKeys[(sortKeys.indexOf(sort) + 1) % sortKeys.length])}
          aria-label={`Sort: ${POOL_SORTS[sort].label}`}
          title="Change sort"
        >
          <ArrowUpDown className="size-3" /> {POOL_SORTS[sort].label}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {tiles.map((a) => (
          <PoolTile key={a.id} ref={tileRef(a.id)} account={a} now={now} max={max} slots={pool.slots} onOpen={() => setOpenId(a.id)} />
        ))}
        {tiles.length === 0 && <div className="col-span-2 py-6 text-center text-xs text-muted-foreground">No accounts match this filter</div>}
      </div>

      {pool.cohorts.length > 1 && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span>Weekly refills</span>
            <span className="font-normal normal-case tracking-normal">{pool.cohorts.length} cohorts</span>
          </div>
          <div className="rounded-xl bg-muted/50 px-2.5 py-1 text-xs tabular-nums">
            {pool.cohorts.map((c) => (
              <div key={c.resetsAt} className="flex items-center justify-between gap-2 border-b py-1.5 last:border-b-0">
                <span className="whitespace-nowrap">
                  {c.count} {c.count === 1 ? "acct" : "accts"} · <b>{c.left}%</b>
                </span>
                <span className="truncate text-muted-foreground">
                  {dayTime.format(Date.parse(c.resetsAt))} · {shortUntil(now, c.resetsAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-2.5 border-t pt-2 text-[10.5px] leading-snug text-muted-foreground">
        {counts.sampled}/{counts.live + counts.cooling} sampled
        {counts.unreachable > 0 && <span className="text-amber-500"> · {counts.unreachable} unreachable</span>}
        {pool.axis && <div>Bars: {pool.axis}</div>}
      </div>

      {open && <PoolSheet account={open} pool={pool} max={max} now={now} accent={accent} onNav={nav} onClose={close} />}
    </div>
  )
}

function PoolHero({ pool, now }: { pool: PoolData; now: number }) {
  const five = asBar("5h", pool.five)
  const week = asBar("7d", pool.week)
  const pace = week ? weeklyPace(week, now) : null
  const dry = firstDry(pool, now)
  const { counts } = pool
  const sub = [
    `${counts.total} accounts`,
    `mean of ${counts.sampled}`,
    counts.offline ? `${counts.offline} offline` : null,
    counts.cooling ? `${counts.cooling} cooling` : null,
  ].filter(Boolean)
  return (
    <div className="mb-2.5 rounded-2xl border bg-[linear-gradient(180deg,color-mix(in_srgb,var(--acc)_12%,transparent),transparent_140%)] p-3">
      <div className="flex items-center gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">Gemini pool</div>
          <div className="text-[11px] leading-snug text-muted-foreground">
            {sub.map((s, i) => (
              <span key={s} className={cn("whitespace-nowrap", i >= 2 && "text-red-500")}>
                {i > 0 && " · "}
                {s}
              </span>
            ))}
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-[var(--acc)]/15 px-1.5 text-[10px] font-semibold text-[var(--acc)]">round-robin</span>
      </div>
      <div className="mt-2.5 grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2.5">
        <AccountRing row={ringRow({ five: pool.five, week: pool.week })} size={64} />
        <div className="min-w-0 text-[11px] text-muted-foreground tabular-nums">
          {five && (
            <>
              <div className="mb-1 flex justify-between gap-2">
                <span className="whitespace-nowrap">5h <b className="text-foreground">{Math.round(100 - five.used)}%</b> left</span>
                {five.resetsAt && <span className="whitespace-nowrap">↻ {shortUntil(now, five.resetsAt)}</span>}
              </div>
              <WindowBar used={five.used} elapsed={elapsedPct(five, now)} label="Pool 5 hour window" />
              <div className={cn("mt-0.5 truncate text-[10.5px]", dry ? "text-red-500" : TONE_TEXT[burn(five, now).tone])}>
                {dry ? `${dry.account.name} dry ~${formatCompactDuration(dry.ms) ?? "<1m"}` : burn(five, now).text}
              </div>
            </>
          )}
          {week && (
            <>
              <div className="mt-2 mb-1 flex justify-between gap-2">
                <span className="whitespace-nowrap">Weekly <b className="text-foreground">{Math.round(100 - week.used)}%</b></span>
                {week.resetsAt && <span className="whitespace-nowrap">↻ {shortUntil(now, week.resetsAt)}</span>}
              </div>
              <WindowBar used={week.used} elapsed={elapsedPct(week, now)} marker={pace?.expected} label="Pool weekly window" />
              {pace && <div className={cn("mt-0.5 text-[10.5px]", pace.delta >= 0 ? "text-green-500" : "text-red-500")}>{pace.text}</div>}
            </>
          )}
        </div>
      </div>
      {(pool.restWeek || pool.restFive) && (
        <div className="mt-2.5 flex items-center justify-between gap-2 border-t pt-2 text-[11px] text-muted-foreground tabular-nums">
          <span>Claude &amp; GPT</span>
          <span className="whitespace-nowrap" title={[pool.restWeek?.resetsAt && `wk ↻ ${shortUntil(now, pool.restWeek.resetsAt)}`, pool.restFive?.resetsAt && `5h ↻ ${shortUntil(now, pool.restFive.resetsAt)}`].filter(Boolean).join(" · ")}>
            {pool.restWeek && <>wk <b className="text-foreground">{Math.round(pool.restWeek.left)}%</b></>}
            {pool.restWeek && pool.restFive && " · "}
            {pool.restFive && <>5h <b className="text-foreground">{Math.round(pool.restFive.left)}%</b></>} left
          </span>
        </div>
      )}
    </div>
  )
}

function Kpi({ value, label, title, valueClass, children }: { value: React.ReactNode; label: string; title?: string; valueClass?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-muted/50 px-2 pt-1.5 pb-1.5" title={title}>
      <div className={cn("whitespace-nowrap text-[15px] font-semibold tracking-tight", valueClass)}>{value}</div>
      <div className="truncate text-[10.5px] text-muted-foreground">{label}</div>
      <div className="mt-1 flex gap-[3px]">{children}</div>
    </div>
  )
}
