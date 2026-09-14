import { useEffect, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"
import type { PluginSettingField } from "@/lib/plugin-types"

export type PluginSettingsTarget = {
  id: string
  name: string
  settings: PluginSettingField[]
}

type PluginSettingsSectionProps = {
  plugins: PluginSettingsTarget[]
  /** Called after a plugin's values are written, so its card can re-probe. */
  onSaved?: (pluginId: string) => void
}

type SaveState = "idle" | "saving" | "saved" | "error"

const INPUT_CLASS =
  "w-full h-8 px-2.5 rounded-md border bg-background text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring transition-colors"

function PluginSettingsForm({ plugin, onSaved }: { plugin: PluginSettingsTarget; onSaved?: (id: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [state, setState] = useState<SaveState>("idle")
  const [message, setMessage] = useState<string | null>(null)
  const [reveal, setReveal] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    invoke<Record<string, string>>("get_plugin_config", { pluginId: plugin.id })
      .then((stored) => {
        if (cancelled) return
        setValues(stored)
        setSaved(stored)
      })
      .catch((error) => {
        console.error("Failed to load plugin settings:", error)
        if (!cancelled) {
          setState("error")
          setMessage(String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [plugin.id])

  const dirty = plugin.settings.some((field) => (values[field.key] ?? "") !== (saved[field.key] ?? ""))

  const save = async () => {
    if (!dirty || state === "saving") return
    setState("saving")
    setMessage(null)
    const payload: Record<string, string> = {}
    for (const field of plugin.settings) payload[field.key] = values[field.key] ?? ""
    try {
      await invoke("set_plugin_config", { pluginId: plugin.id, values: payload })
      const next: Record<string, string> = {}
      for (const field of plugin.settings) {
        const trimmed = (values[field.key] ?? "").trim()
        if (trimmed) next[field.key] = trimmed
      }
      setValues(next)
      setSaved(next)
      setState("saved")
      onSaved?.(plugin.id)
    } catch (error) {
      console.error("Failed to save plugin settings:", error)
      setState("error")
      setMessage(String(error))
    }
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="text-sm font-medium">{plugin.name}</div>
      {plugin.settings.map((field) => {
        const isSecret = field.type === "secret"
        const inputId = `plugin-setting-${plugin.id}-${field.key}`
        return (
          <div key={field.key} className="space-y-1">
            <label htmlFor={inputId} className="text-xs text-muted-foreground">
              {field.label}
            </label>
            <div className="flex items-center gap-1.5">
              <input
                id={inputId}
                type={isSecret && !reveal[field.key] ? "password" : field.type === "url" ? "url" : "text"}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={field.placeholder ?? undefined}
                value={values[field.key] ?? ""}
                onChange={(event) => {
                  setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                  if (state !== "idle") setState("idle")
                }}
                className={INPUT_CLASS}
              />
              {isSecret && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-pressed={!!reveal[field.key]}
                  aria-controls={inputId}
                  onClick={() => setReveal((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                  className="flex-shrink-0 text-muted-foreground"
                >
                  {reveal[field.key] ? "Hide" : "Show"}
                </Button>
              )}
            </div>
            {field.help && <p className="text-[11px] text-muted-foreground">{field.help}</p>}
          </div>
        )
      })}
      <div className="flex items-center gap-2 h-6">
        <Button
          type="submit"
          size="xs"
          variant={dirty ? "default" : "outline"}
          disabled={!dirty || state === "saving"}
        >
          {state === "saving" ? "Saving…" : "Save"}
        </Button>
        {state === "saved" && !dirty && <span className="text-xs text-muted-foreground">Saved · refreshing</span>}
        {state === "error" && (
          <span className="text-xs text-destructive truncate" title={message ?? undefined}>
            {message ?? "Save failed"}
          </span>
        )}
      </div>
    </form>
  )
}

export function PluginSettingsSection({ plugins, onSaved }: PluginSettingsSectionProps) {
  if (plugins.length === 0) return null
  return (
    <section>
      <h3 className="text-lg font-semibold mb-0">Plugin Settings</h3>
      <p className="text-sm text-muted-foreground mb-2">Where your relays live</p>
      <div className="bg-muted/50 rounded-lg p-3 space-y-4">
        {plugins.map((plugin) => (
          <PluginSettingsForm key={plugin.id} plugin={plugin} onSaved={onSaved} />
        ))}
      </div>
    </section>
  )
}
