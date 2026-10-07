import { useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { AlertCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { AccountRow } from "@/lib/plugin-types"
import { formatResetRelativeLabel } from "@/lib/reset-tooltip"

type SwitchResponse = { refreshPluginIds: string[] }

interface AccountListProps {
  providerId: string
  rows: AccountRow[]
  now: number
  /** Re-probe these providers after a switch (the active login changed). */
  onSwitched?: (pluginIds: string[]) => void
}

/** "Resets in 3h 40m" → "3h 40m"; the bar label already says which window. */
export function shortReset(now: number, resetsAt?: string): string {
  if (!resetsAt) return ""
  const label = formatResetRelativeLabel(now, resetsAt)
  return label ? label.replace(/^Resets in /, "") : ""
}

export function AccountList({ providerId, rows, now, onSwitched }: AccountListProps) {
  // The slot being switched to ("best" for the footer button), or null.
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const switchTo = async (target: string) => {
    if (pending) return
    setPending(target)
    setError(null)
    try {
      const res = await invoke<SwitchResponse>("switch_account", { providerId, target })
      onSwitched?.(res.refreshPluginIds)
    } catch (err) {
      console.error("Failed to switch account:", err)
      setError(String(err))
    } finally {
      setPending(null)
    }
  }

  return (
    <div>
      <div className="divide-y">
        {rows.map((row) => (
          <div key={row.id} className="py-2.5 first:pt-0">
            <div className="flex items-center gap-1.5 mb-1.5 min-w-0">
              <span className="text-sm font-medium shrink-0">{row.name}</span>
              {row.active && (
                <span className="text-[11px] rounded-full px-2 bg-primary text-primary-foreground shrink-0">active</span>
              )}
              {row.flag && (
                <span className="text-[11px] rounded-full px-2 bg-destructive/10 text-destructive shrink-0">{row.flag}</span>
              )}
              <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">{row.detail}</span>
              {!row.active && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={pending !== null}
                  onClick={() => void switchTo(row.id)}
                  aria-label={`Switch to ${row.name}`}
                >
                  {pending === row.id ? <Loader2 className="animate-spin" /> : "Switch"}
                </Button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {row.bars.map((bar) => (
                <div key={bar.label}>
                  <Progress value={bar.used} className="h-2" aria-label={`${row.name} ${bar.label}`} />
                  <div className="flex justify-between text-[11px] text-muted-foreground mt-1 tabular-nums">
                    <span>
                      {bar.label} {Math.round(bar.used)}%
                    </span>
                    <span>{shortReset(now, bar.resetsAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {error && (
        <div className="flex items-center gap-1.5 mt-2 text-xs text-destructive">
          <AlertCircle className="h-3 w-3 flex-shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}
      {rows.length > 1 && (
        <Button
          size="xs"
          className="mt-2"
          disabled={pending !== null}
          onClick={() => void switchTo("best")}
        >
          {pending === "best" ? <Loader2 className="animate-spin" /> : "Switch to best"}
        </Button>
      )}
    </div>
  )
}
