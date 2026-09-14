import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { PluginSettingsSection } from "@/components/plugin-settings-section"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}))

const plugin = {
  id: "antigravity-pool",
  name: "Antigravity Pool",
  settings: [
    { key: "baseUrl", label: "Relay URL", type: "url" as const, placeholder: "http://100.105.72.106:8317" },
    { key: "managementKey", label: "Management key", type: "secret" as const, help: "from .env" },
  ],
}

describe("PluginSettingsSection", () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockReset()
  })

  it("renders nothing without plugins that declare settings", () => {
    const { container } = render(<PluginSettingsSection plugins={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("loads stored values, masks secrets, and saves trimmed values", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "get_plugin_config") return { baseUrl: "http://relay:8317" }
      return undefined
    })
    const onSaved = vi.fn()
    render(<PluginSettingsSection plugins={[plugin]} onSaved={onSaved} />)

    const url = (await screen.findByLabelText("Relay URL")) as HTMLInputElement
    await waitFor(() => expect(url.value).toBe("http://relay:8317"))
    const key = screen.getByLabelText("Management key") as HTMLInputElement
    expect(key.type).toBe("password")
    expect(screen.getByText("from .env")).toBeInTheDocument()

    const save = screen.getByRole("button", { name: "Save" })
    expect(save).toBeDisabled()

    await userEvent.type(key, "  secret-value ")
    expect(save).toBeEnabled()
    await userEvent.click(screen.getByRole("button", { name: "Show" }))
    expect(key.type).toBe("text")

    await userEvent.click(save)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_plugin_config", {
        pluginId: "antigravity-pool",
        values: { baseUrl: "http://relay:8317", managementKey: "  secret-value " },
      })
    )
    await waitFor(() => expect(key.value).toBe("secret-value"))
    expect(onSaved).toHaveBeenCalledWith("antigravity-pool")
    expect(screen.getByText("Saved · refreshing")).toBeInTheDocument()
  })

  it("saves on Enter and surfaces a failed save", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "get_plugin_config") return {}
      throw new Error("write config: permission denied")
    })
    render(<PluginSettingsSection plugins={[plugin]} />)
    const url = (await screen.findByLabelText("Relay URL")) as HTMLInputElement
    await userEvent.type(url, "http://relay:8317{Enter}")
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument()
  })
})
