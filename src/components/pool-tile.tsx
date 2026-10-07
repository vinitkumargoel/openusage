import { forwardRef } from "react"
import { AccountRing } from "@/components/account-ring"
import type { PoolAccount } from "@/lib/plugin-types"
import { TONE_TEXT } from "@/lib/account-stats"
import { accountStatus, compact, ringRow, shortUntil, sum } from "@/lib/pool-stats"
import { cn } from "@/lib/utils"

/** Requests per bucket on a shared scale; failures stack on top in red. */
export function MiniBars({
  requests,
  failures,
  max,
  height = 18,
  slots,
}: {
  requests: number[]
  failures: number[]
  max: number
  height?: number
  slots?: string[]
}) {
  if (requests.length === 0) return <div style={{ height }} className="border-b border-dashed" />
  return (
    <div className="flex items-end gap-px" style={{ height }} role="img" aria-label={`${sum(requests)} requests, ${sum(failures)} failed`}>
      {requests.map((r, i) => {
        const f = failures[i] ?? 0
        const total = r + f
        return (
          <div
            key={i}
            className="flex flex-1 flex-col justify-end"
            style={{ height: "100%" }}
            title={slots?.[i] ? `${slots[i]} · ${r} ok${f ? ` · ${f} failed` : ""}` : undefined}
          >
            {f > 0 && <div className="bg-red-500" style={{ height: `${(f / max) * 100}%`, minHeight: 1 }} />}
            <div
              className={total > 0 ? "bg-[var(--acc)]" : "bg-muted"}
              style={{ height: total > 0 ? `${(r / max) * 100}%` : 2, minHeight: r > 0 ? 1 : undefined }}
            />
          </div>
        )
      })}
    </div>
  )
}

const TAG_STYLE: Record<string, string> = {
  cooling: "bg-red-500/15 text-red-500",
  offline: "bg-red-500/15 text-red-500",
  model: "bg-amber-500/15 text-amber-500",
  free: "bg-muted text-muted-foreground",
  sampling: "bg-muted text-muted-foreground",
}

export function PoolTag({ account }: { account: PoolAccount }) {
  const tag = account.state === "live" ? account.tag : account.state === "cooling" ? "cooling" : account.state
  if (!tag) return null
  const label = tag === "cooling" ? "cool" : tag === "offline" ? "off" : tag === "sampling" ? "…" : tag
  return <span className={cn("shrink-0 rounded-full px-1.5 text-[10px] font-semibold", TAG_STYLE[tag] ?? TAG_STYLE.free)}>{label}</span>
}

interface PoolTileProps {
  account: PoolAccount
  now: number
  max: number
  slots: string[]
  onOpen: () => void
}

export const PoolTile = forwardRef<HTMLDivElement, PoolTileProps>(function PoolTile({ account: a, now, max, slots, onOpen }, ref) {
  const status = accountStatus(a, now)
  const bad = a.state === "cooling" || a.state === "offline"
  const reset = a.five?.resetsAt ? `↻ ${shortUntil(now, a.five.resetsAt)}` : a.week?.resetsAt ? `wk ↻ ${shortUntil(now, a.week.resetsAt)}` : "—"
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={`${a.name} details`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-xl border border-transparent bg-muted/50 p-2 pb-1.5 cursor-pointer transition-colors hover:bg-muted hover:border-border focus-visible:outline-2 focus-visible:outline-[var(--acc)]",
        bad && "border-red-500/40",
        a.state === "offline" && "opacity-70"
      )}
    >
      <div className="flex items-center gap-1 min-w-0">
        <span className={cn("flex-1 min-w-0 truncate text-[12.5px] font-semibold", bad && "text-red-500")} title={a.name}>
          {a.name}
        </span>
        <PoolTag account={a} />
      </div>
      <div className="flex items-center gap-2 min-w-0">
        <AccountRing row={ringRow(a)} size={46} />
        <div className="min-w-0 whitespace-nowrap text-[10.5px] leading-[1.55] text-muted-foreground tabular-nums">
          <div>
            5h <b className="font-semibold text-foreground">{a.five ? `${Math.round(100 - a.five.left)}%` : "—"}</b>
          </div>
          <div>
            wk <b className="font-semibold text-foreground">{a.week ? `${Math.round(100 - a.week.left)}%` : "—"}</b>
          </div>
          <div className={cn("truncate", TONE_TEXT[status.tone])}>{status.text}</div>
        </div>
      </div>
      <MiniBars requests={a.requests} failures={a.failures} max={max} slots={slots} />
      <div className="flex items-center justify-between gap-1 border-t pt-1.5 text-[10.5px] text-muted-foreground tabular-nums">
        <span className="truncate">{reset}</span>
        <span className="flex-none">{compact(sum(a.requests))} req</span>
      </div>
    </div>
  )
})
