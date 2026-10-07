import { render, screen, waitFor, within } from "@testing-library/react"
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
const H5 = 5 * 60 * 60 * 1000

const rows: AccountRow[] = [
  {
    id: "1",
    name: "personal",
    detail: "personal@example.com",
    active: true,
    bars: [
      { label: "5h", used: 40, resetsAt: "2026-10-07T14:00:00Z", periodMs: H5 },
      { label: "7d", used: 61, expected: 70 },
    ],
    stats: [{ label: "Fable", value: "3% used" }],
  },
  { id: "2", name: "work", detail: "work@corp.com", active: false, bars: [{ label: "5h", used: 10, resetsAt: "2026-10-07T13:00:00Z", periodMs: H5 }] },
  { id: "3", name: "side", detail: "side@example.com", active: false, flag: "limit", bars: [{ label: "5h", used: 95 }] },
]

describe("AccountList", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it("puts the active account up top with burn and weekly pace, others as tiles", () => {
    render(<AccountList providerId="claude-accounts" rows={rows} now={NOW} />)
    // 40% used with 60% of the window gone → on pace for 67%.
    expect(screen.getAllByText("on pace for 67%").length).toBeGreaterThan(0)
    expect(screen.getByText("9% under pace")).toBeInTheDocument()
    expect(screen.getByText("limit")).toBeInTheDocument()
    expect(screen.getByText("best")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Switch to personal" })).toBeNull()
    expect(screen.getByRole("button", { name: "Switch to side" })).toBeInTheDocument()
    expect(screen.getByText("ready to switch").previousElementSibling).toHaveTextContent("1/2")
  })

  it("switches through the app command, refreshes, and offers undo", async () => {
    vi.mocked(invoke).mockResolvedValue({ result: { switched: true }, refreshPluginIds: ["claude-accounts", "claude"] })
    const onSwitched = vi.fn()
    render(<AccountList providerId="claude-accounts" rows={rows} now={NOW} onSwitched={onSwitched} />)

    await userEvent.click(screen.getByRole("button", { name: "Switch to side" }))

    expect(invoke).toHaveBeenCalledWith("switch_account", { providerId: "claude-accounts", target: "3" })
    await waitFor(() => expect(onSwitched).toHaveBeenCalledWith(["claude-accounts", "claude"]))
    expect(screen.getByRole("status")).toHaveTextContent("Switched to side")
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument()
  })

  it("switch to best targets the ready account with most headroom", async () => {
    vi.mocked(invoke).mockResolvedValue({ result: {}, refreshPluginIds: [] })
    render(<AccountList providerId="claude-accounts" rows={rows} now={NOW} />)
    await userEvent.click(screen.getByRole("button", { name: "Switch to best" }))
    expect(invoke).toHaveBeenCalledWith("switch_account", { providerId: "claude-accounts", target: "2" })
  })

  it("filters and opens a detail sheet with every stat", async () => {
    render(<AccountList providerId="claude-accounts" rows={rows} now={NOW} />)
    await userEvent.click(screen.getByRole("button", { name: /Ready/ }))
    expect(screen.queryByRole("button", { name: "side details" })).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: "personal details" }))
    const sheet = screen.getByRole("dialog", { name: "personal details" })
    expect(within(sheet).getByText("Fable")).toBeInTheDocument()
    expect(within(sheet).getByText("Active now")).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).toBeNull()
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
