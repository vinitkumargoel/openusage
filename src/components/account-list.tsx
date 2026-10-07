import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { AlertCircle, ArrowUpDown, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AccountSheet } from "@/components/account-sheet"
import { AccountTile, ActiveHero, Slot } from "@/components/account-tile"
import type { AccountRow } from "@/lib/plugin-types"
import { FILTERS, SORTS, barOf, elapsedPct, headroom, isReady, pickBest, until, usedTone, type FilterKey, type SortKey } from "@/lib/account-stats"
import { formatResetRelativeLabel } from "@/lib/reset-tooltip"

type SwitchResponse = { refreshPluginIds: string[] }

const TONE_BG = { ok: "bg-green-500", warn: "bg-amber-500", bad: "bg-red-500", muted: "bg-muted-foreground" }
const NOTICE_MS = 6000

interface AccountListProps {
  providerId: string
  rows: AccountRow[]
  now: number
  /** Brand color for the active account and Switch links. */
  accent?: string
  /** Re-probe these providers after a switch (the active login changed). */
  onSwitched?: (pluginIds: string[]) => void
}

/** "Resets in 3h 40m" → "3h 40m"; the bar label already says which window. */
export function shortReset(now: number, resetsAt?: string): string {
  if (!resetsAt) return ""
  const label = formatResetRelativeLabel(now, resetsAt)
  return label ? label.replace(/^Resets in /, "") : ""
}

/** Slides tiles from their old spot when sort, filter or the active account changes. */
function useTileMotion() {
  const nodes = useRef(new Map<string, HTMLDivElement>())
  const last = useRef(new Map<string, { x: number; y: number }>())
  useLayoutEffect(() => {
    const next = new Map<string, { x: number; y: number }>()
    nodes.current.forEach((el, id) => {
      const pos = { x: el.offsetLeft, y: el.offsetTop }
      next.set(id, pos)
      const prev = last.current.get(id)
      if (prev && (prev.x !== pos.x || prev.y !== pos.y)) {
        el.animate?.(
          [{ transform: `translate(${prev.x - pos.x}px, ${prev.y - pos.y}px)` }, { transform: "none" }],
          { duration: 350, easing: "cubic-bezier(.2,.8,.2,1)" }
        )
      }
    })
    last.current = next
  })
  return (id: string) => (el: HTMLDivElement | null) => {
    if (el) nodes.current.set(id, el)
    else nodes.current.delete(id)
  }
}

export function AccountList({ providerId, rows, now, accent = "#DE7356", onSwitched }: AccountListProps) {
  // The slot being switched to, or null.
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ name: string; undoId?: string } | null>(null)
  const [filter, setFilter] = useState<FilterKey>("all")
  const [sort, setSort] = useState<SortKey>("free")
  const [openId, setOpenId] = useState<string | null>(null)
  const tileRef = useTileMotion()

  const active = rows.find((r) => r.active)
  const best = pickBest(rows)
  const others = rows.filter((r) => !r.active)
  const tiles = rows.filter(FILTERS[filter].test).sort(SORTS[sort].cmp)
  const order = active ? [active, ...tiles] : tiles
  const open = openId ? rows.find((r) => r.id === openId) : undefined

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice])

  const switchTo = useCallback(
    async (id: string, undoable = true) => {
      if (pending) return
      const target = rows.find((r) => r.id === id)
      if (!target || target.active) return
      const from = rows.find((r) => r.active)
      setPending(id)
      setError(null)
      try {
        const res = await invoke<SwitchResponse>("switch_account", { providerId, target: id })
        setOpenId(null)
        setNotice({ name: target.name, undoId: undoable ? from?.id : undefined })
        onSwitched?.(res.refreshPluginIds)
      } catch (err) {
        console.error("Failed to switch account:", err)
        setError(String(err))
      } finally {
        setPending(null)
      }
    },
    [pending, rows, providerId, onSwitched]
  )

  const nav = useCallback(
    (step: number) => {
      if (order.length === 0) return
      const i = order.findIndex((r) => r.id === openId)
      setOpenId(order[(i + step + order.length) % order.length].id)
    },
    [order, openId]
  )
  const close = useCallback(() => setOpenId(null), [])

  const nextReset = rows
    .map((r) => ({ r, bar: barOf(r, "5h") }))
    .filter((x) => x.bar?.resetsAt)
    .sort((a, b) => Date.parse(a.bar!.resetsAt!) - Date.parse(b.bar!.resetsAt!))[0]
  const poolFree = rows.filter((r) => r.flag !== "expired").reduce((s, r) => s + (100 - (barOf(r, "5h")?.used ?? 100)), 0) / 100
  const ready = others.filter(isReady).length
  const sortKeys = Object.keys(SORTS) as SortKey[]

  return (
    <div style={{ "--acc": accent } as React.CSSProperties}>
      {active && <ActiveHero row={active} now={now} onOpen={() => setOpenId(active.id)} />}

      {others.length > 0 && (
        <div className="mb-2.5 grid grid-cols-3 gap-1.5 tabular-nums">
          <Kpi value={<>{ready}<small className="text-[11px] font-medium text-muted-foreground">/{others.length}</small></>} label="ready" valueClass={ready ? "text-green-500" : "text-red-500"}>
            {others.map((r) => (
              <i key={r.id} title={`#${r.id} ${r.name}`} className={`h-1 flex-1 rounded-sm ${r.flag ? "bg-red-500" : TONE_BG[usedTone(100 - headroom(r))]}`} style={{ opacity: r.flag ? 1 : 0.35 + headroom(r) / 150 }} />
            ))}
          </Kpi>
          <Kpi value={<>{poolFree.toFixed(1)}<small className="text-[11px] font-medium text-muted-foreground">/{rows.length}</small></>} label="5h free">
            {rows.map((r) => {
              const used = barOf(r, "5h")?.used ?? 100
              return <i key={r.id} className="h-1 flex-1 rounded-sm bg-muted overflow-hidden"><i className={`block h-full ${TONE_BG[usedTone(used)]}`} style={{ width: `${100 - used}%` }} /></i>
            })}
          </Kpi>
          {nextReset && (
            <Kpi value={until(now, nextReset.bar!.resetsAt)} label="next reset" title={`#${nextReset.r.id} ${nextReset.r.name}`}>
              <i className="h-1 flex-1 rounded-sm bg-muted overflow-hidden"><i className="block h-full bg-[var(--acc)]" style={{ width: `${elapsedPct(nextReset.bar!, now) ?? 0}%` }} /></i>
            </Kpi>
          )}
        </div>
      )}

      {others.length > 0 && (
        <div className="mb-2 flex items-center gap-1.5">
          <div className="flex min-w-0 gap-1 overflow-x-auto [scrollbar-width:none]">
            {(Object.keys(FILTERS) as FilterKey[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                aria-pressed={filter === k}
                className={`whitespace-nowrap rounded-full border px-1.5 py-px text-[11px] ${filter === k ? "border-foreground bg-foreground text-background" : "text-muted-foreground"}`}
              >
                {FILTERS[k].label}
                <span className="ml-1 opacity-60">{rows.filter(FILTERS[k].test).length}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            title={`Sort: ${SORTS[sort].label}`}
            className="ml-auto flex flex-none items-center gap-1 whitespace-nowrap rounded-md p-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setSort(sortKeys[(sortKeys.indexOf(sort) + 1) % sortKeys.length])}
            aria-label={`Sort: ${SORTS[sort].label}`}
          >
            <ArrowUpDown className="size-3.5" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {tiles.map((row) => (
          <AccountTile
            key={row.id}
            ref={tileRef(row.id)}
            row={row}
            isBest={best?.id === row.id}
            now={now}
            pending={pending}
            onOpen={() => setOpenId(row.id)}
            onSwitch={() => void switchTo(row.id)}
          />
        ))}
        {others.length > 0 && tiles.length === 0 && (
          <div className="col-span-2 py-6 text-center text-xs text-muted-foreground">No accounts match this filter</div>
        )}
      </div>

      {notice && (
        <div role="status" className="mt-2 flex items-center gap-2 rounded-lg bg-foreground px-3 py-2 text-xs text-background animate-in fade-in slide-in-from-bottom-1">
          <span className="flex-1">
            Switched to <b>{notice.name}</b> · Claude card refreshing
          </span>
          {notice.undoId && (
            <button type="button" className="font-semibold text-[var(--acc)]" onClick={() => { const id = notice.undoId!; setNotice(null); void switchTo(id, false) }}>
              Undo
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-1.5 mt-2 text-xs text-destructive">
          <AlertCircle className="h-3 w-3 flex-shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {others.length > 0 && (
        <div className="mt-2.5 flex items-center gap-2 border-t pt-2.5">
          {best ? (
            <>
              <Slot row={best} size={24} />
              <div className="min-w-0 flex-1 truncate text-[11.5px] leading-tight text-muted-foreground">
                Best: <b className="text-foreground">{best.name}</b>
                <br />
                {headroom(best)}% left
              </div>
              <Button size="sm" className="bg-[var(--acc)] text-white hover:bg-[var(--acc)]/90" disabled={pending !== null} onClick={() => void switchTo(best.id)}>
                {pending === best.id ? <Loader2 className="animate-spin" /> : "Switch to best"}
              </Button>
            </>
          ) : (
            <div className="text-xs text-red-500">
              No account ready.{nextReset ? ` Next reset in ${until(now, nextReset.bar!.resetsAt)}.` : ""}
            </div>
          )}
        </div>
      )}

      {open && (
        <AccountSheet row={open} isBest={best?.id === open.id} now={now} pending={pending} onSwitch={(id) => void switchTo(id)} onNav={nav} onClose={close} />
      )}
    </div>
  )
}

function Kpi({ value, label, title, valueClass, children }: { value: React.ReactNode; label: string; title?: string; valueClass?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-muted/50 px-2 pt-1.5 pb-1.5" title={title}>
      <div className={`whitespace-nowrap text-[15px] font-semibold tracking-tight ${valueClass ?? ""}`}>{value}</div>
      <div className="truncate text-[10.5px] text-muted-foreground">{label}</div>
      <div className="mt-1 flex gap-[3px]">{children}</div>
    </div>
  )
}
