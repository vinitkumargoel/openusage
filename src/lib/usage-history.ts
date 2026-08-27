import { LazyStore } from "@tauri-apps/plugin-store"
import { formatDayKey } from "@/lib/utils"
import type { HeatmapDay, MetricLine, ProgressFormat } from "@/lib/plugin-types"

// App-side daily usage history for providers whose plugins don't emit their
// own heatmap line. On each successful refresh the delta of the primary
// progress metric is accumulated into today's bucket, so a heatmap fills in
// from install day forward.

const HISTORY_STORE_PATH = "usage-history.json"
const RETENTION_DAYS = 400

export type ProviderHistory = {
  days: Record<string, number>
  last: { label: string; used: number } | null
  format?: ProgressFormat
}

const store = new LazyStore(HISTORY_STORE_PATH)

/**
 * Pure snapshot step: returns the next history for a provider given its
 * latest probe lines, or null when there is nothing to record (the plugin
 * emits its own heatmap, or has no progress line).
 */
export function applySnapshot(
  history: ProviderHistory | null | undefined,
  lines: MetricLine[],
  now: Date
): ProviderHistory | null {
  if (lines.some((line) => line.type === "heatmap")) return null
  const primary = lines.find((line) => line.type === "progress")
  if (!primary) return null

  const previous = history?.last ?? null
  let delta = 0
  if (previous && previous.label === primary.label) {
    if (primary.used > previous.used) {
      delta = primary.used - previous.used
    } else if (primary.used < previous.used) {
      // Period reset since last sample: current `used` is what accumulated
      // in the new period, count it as today's usage.
      delta = primary.used
    }
  }

  const days = { ...(history?.days ?? {}) }
  if (delta > 0) {
    const todayKey = formatDayKey(now)
    days[todayKey] = (days[todayKey] ?? 0) + delta
  }

  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS)
  const cutoffKey = formatDayKey(cutoff)
  for (const key of Object.keys(days)) {
    if (key < cutoffKey) delete days[key]
  }

  return {
    days,
    last: { label: primary.label, used: primary.used },
    format: primary.format,
  }
}

/** Records one successful probe result. Fire-and-forget from the probe path. */
export async function recordUsageSnapshot(
  pluginId: string,
  lines: MetricLine[],
  now: Date = new Date()
): Promise<void> {
  const history = await store.get<ProviderHistory>(pluginId)
  const next = applySnapshot(history, lines, now)
  if (!next) return
  await store.set(pluginId, next)
  await store.save()
}

/**
 * Recorded history as a renderable heatmap line, or null when nothing has
 * been recorded yet (the detail page hides the block in that case).
 */
export async function loadRecordedHeatmapLine(pluginId: string): Promise<MetricLine | null> {
  const history = await store.get<ProviderHistory>(pluginId)
  if (!history) return null
  const days: HeatmapDay[] = Object.entries(history.days)
    .filter(([, value]) => value > 0)
    .map(([date, value]) => ({ date, value }))
  if (days.length === 0) return null
  return { type: "heatmap", label: "Activity", days, format: history.format }
}
