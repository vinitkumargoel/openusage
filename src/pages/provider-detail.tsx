import { useEffect, useState } from "react"
import { ProviderCard } from "@/components/provider-card"
import { loadRecordedHeatmapLine } from "@/lib/usage-history"
import type { MetricLine, PluginDisplayState } from "@/lib/plugin-types"
import type { DisplayMode, ResetTimerDisplayMode, TimeFormatMode } from "@/lib/settings"

interface ProviderDetailPageProps {
  plugin: PluginDisplayState | null
  onRetry?: () => void
  displayMode: DisplayMode
  resetTimerDisplayMode: ResetTimerDisplayMode
  timeFormatMode?: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
}

export function ProviderDetailPage({
  plugin,
  onRetry,
  displayMode,
  resetTimerDisplayMode,
  timeFormatMode = "auto",
  onResetTimerDisplayModeToggle,
}: ProviderDetailPageProps) {
  // Fallback heatmap from app-recorded history, for plugins that don't emit
  // their own heatmap line. Hidden until something has been recorded.
  const [recordedHeatmap, setRecordedHeatmap] = useState<MetricLine | null>(null)
  const pluginId = plugin?.meta.id
  const pluginLines = plugin?.data?.lines
  const lastUpdatedAt = plugin?.lastUpdatedAt
  const hasOwnHeatmap = pluginLines?.some((line) => line.type === "heatmap") ?? false

  useEffect(() => {
    let cancelled = false
    setRecordedHeatmap(null)
    if (!pluginId || hasOwnHeatmap || !pluginLines) return
    loadRecordedHeatmapLine(pluginId)
      .then((line) => {
        if (!cancelled) setRecordedHeatmap(line)
      })
      .catch((error) => {
        console.error("Failed to load recorded heatmap:", error)
      })
    return () => {
      cancelled = true
    }
  }, [pluginId, hasOwnHeatmap, pluginLines, lastUpdatedAt])

  if (!plugin) {
    return (
      <div className="text-center text-muted-foreground py-8">
        Provider not found
      </div>
    )
  }

  const lines = plugin.data?.lines ?? []

  return (
    <ProviderCard
      name={plugin.meta.name}
      plan={plugin.data?.plan}
      brandColor={plugin.meta.brandColor}
      links={plugin.meta.links}
      showSeparator={false}
      loading={plugin.loading}
      error={plugin.error}
      lines={recordedHeatmap ? [...lines, recordedHeatmap] : lines}
      skeletonLines={plugin.meta.lines}
      lastManualRefreshAt={plugin.lastManualRefreshAt}
      lastUpdatedAt={plugin.lastUpdatedAt}
      onRetry={onRetry}
      scopeFilter="all"
      displayMode={displayMode}
      resetTimerDisplayMode={resetTimerDisplayMode}
      timeFormatMode={timeFormatMode}
      onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
    />
  )
}
