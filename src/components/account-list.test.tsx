import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { AccountList, shortReset } from "@/components/account-list"
import type { AccountRow } from "@/lib/plugin-types"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}))

const NOW = Date.parse("2026-10-07T12:00:00Z")

const rows: AccountRow[] = [
  {
    id: "1",
    name: "personal",
    detail: "personal@example.com",
    active: true,
    bars: [
      { label: "5h", used: 92, resetsAt: "2026-10-07T13:04:00Z" },
      { label: "7d", used: 61 },
    ],
  },
  { id: "3", name: "side", detail: "side@example.com", active: false, flag: "limit", bars: [] },
]

describe("AccountList", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it("shows every account, its tags and bars, with Switch only on inactive rows", () => {
    render(<AccountList providerId="claude-accounts" rows={rows} now={NOW} />)
    expect(screen.getByText("active")).toBeInTheDocument()
    expect(screen.getByText("limit")).toBeInTheDocument()
    expect(screen.getByText("5h 92%")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Switch to personal" })).toBeNull()
    expect(screen.getByRole("button", { name: "Switch to side" })).toBeInTheDocument()
  })

  it("switches through the app command and refreshes what it names", async () => {
    vi.mocked(invoke).mockResolvedValue({ result: { switched: true }, refreshPluginIds: ["claude-accounts", "claude"] })
    const onSwitched = vi.fn()
    render(<AccountList providerId="claude-accounts" rows={rows} now={NOW} onSwitched={onSwitched} />)

    await userEvent.click(screen.getByRole("button", { name: "Switch to side" }))

    expect(invoke).toHaveBeenCalledWith("switch_account", { providerId: "claude-accounts", target: "3" })
    await waitFor(() => expect(onSwitched).toHaveBeenCalledWith(["claude-accounts", "claude"]))
  })

  it("switch to best passes the best target", async () => {
    vi.mocked(invoke).mockResolvedValue({ result: {}, refreshPluginIds: [] })
    render(<AccountList providerId="claude-accounts" rows={rows} now={NOW} />)
    await userEvent.click(screen.getByRole("button", { name: "Switch to best" }))
    expect(invoke).toHaveBeenCalledWith("switch_account", { providerId: "claude-accounts", target: "best" })
  })

  it("shows the error when a switch fails and doesn't refresh", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.mocked(invoke).mockRejectedValue("cswap not found")
    const onSwitched = vi.fn()
    render(<AccountList providerId="claude-accounts" rows={rows} now={NOW} onSwitched={onSwitched} />)

    await userEvent.click(screen.getByRole("button", { name: "Switch to side" }))

    expect(await screen.findByText("cswap not found")).toBeInTheDocument()
    expect(onSwitched).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it("shortReset drops the prefix and handles missing times", () => {
    expect(shortReset(NOW, "2026-10-07T13:04:00Z")).toBe("1h 4m")
    expect(shortReset(NOW, undefined)).toBe("")
  })
})
