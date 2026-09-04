import { useCallback } from "react"
import {
  saveDisplayMode,
  saveHeatmapUnit,
  saveMenubarIconStyle,
  saveResetTimerDisplayMode,
  saveThemeMode,
  saveTimeFormatMode,
  type DisplayMode,
  type HeatmapUnit,
  type MenubarIconStyle,
  type ResetTimerDisplayMode,
  type ThemeMode,
  type TimeFormatMode,
} from "@/lib/settings"

type ScheduleTrayIconUpdate = (reason: "probe" | "settings" | "init", delayMs?: number) => void

type UseSettingsDisplayActionsArgs = {
  setThemeMode: (value: ThemeMode) => void
  setDisplayMode: (value: DisplayMode) => void
  resetTimerDisplayMode: ResetTimerDisplayMode
  setResetTimerDisplayMode: (value: ResetTimerDisplayMode) => void
  setTimeFormatMode: (value: TimeFormatMode) => void
  setHeatmapUnit: (value: HeatmapUnit) => void
  setMenubarIconStyle: (value: MenubarIconStyle) => void
  scheduleTrayIconUpdate: ScheduleTrayIconUpdate
}

export function useSettingsDisplayActions({
  setThemeMode,
  setDisplayMode,
  resetTimerDisplayMode,
  setResetTimerDisplayMode,
  setTimeFormatMode,
  setHeatmapUnit,
  setMenubarIconStyle,
  scheduleTrayIconUpdate,
}: UseSettingsDisplayActionsArgs) {
  const handleThemeModeChange = useCallback((mode: ThemeMode) => {
    setThemeMode(mode)
    void saveThemeMode(mode).catch((error) => {
      console.error("Failed to save theme mode:", error)
    })
  }, [setThemeMode])

  const handleDisplayModeChange = useCallback((mode: DisplayMode) => {
    setDisplayMode(mode)
    scheduleTrayIconUpdate("settings", 0)
    void saveDisplayMode(mode).catch((error) => {
      console.error("Failed to save display mode:", error)
    })
  }, [scheduleTrayIconUpdate, setDisplayMode])

  const handleResetTimerDisplayModeChange = useCallback((mode: ResetTimerDisplayMode) => {
    setResetTimerDisplayMode(mode)
    void saveResetTimerDisplayMode(mode).catch((error) => {
      console.error("Failed to save reset timer display mode:", error)
    })
  }, [setResetTimerDisplayMode])

  const handleResetTimerDisplayModeToggle = useCallback(() => {
    const next = resetTimerDisplayMode === "relative" ? "absolute" : "relative"
    handleResetTimerDisplayModeChange(next)
  }, [handleResetTimerDisplayModeChange, resetTimerDisplayMode])

  const handleTimeFormatModeChange = useCallback((mode: TimeFormatMode) => {
    setTimeFormatMode(mode)
    void saveTimeFormatMode(mode).catch((error) => {
      console.error("Failed to save time format mode:", error)
    })
  }, [setTimeFormatMode])

  const handleHeatmapUnitChange = useCallback((unit: HeatmapUnit) => {
    setHeatmapUnit(unit)
    void saveHeatmapUnit(unit).catch((error) => {
      console.error("Failed to save heatmap unit:", error)
    })
  }, [setHeatmapUnit])

  const handleMenubarIconStyleChange = useCallback((style: MenubarIconStyle) => {
    setMenubarIconStyle(style)
    scheduleTrayIconUpdate("settings", 0)
    void saveMenubarIconStyle(style).catch((error) => {
      console.error("Failed to save menubar icon style:", error)
    })
  }, [scheduleTrayIconUpdate, setMenubarIconStyle])

  return {
    handleThemeModeChange,
    handleDisplayModeChange,
    handleResetTimerDisplayModeChange,
    handleResetTimerDisplayModeToggle,
    handleTimeFormatModeChange,
    handleHeatmapUnitChange,
    handleMenubarIconStyleChange,
  }
}
