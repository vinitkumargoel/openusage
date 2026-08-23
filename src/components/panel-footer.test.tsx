import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { PanelFooter } from "@/components/panel-footer"

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}))

const noop = () => {}
const footerProps = { showAbout: false, onShowAbout: noop, onCloseAbout: noop }

describe("PanelFooter", () => {
  it("shows countdown in minutes when >= 60 seconds", () => {
    const futureTime = Date.now() + 5 * 60 * 1000 // 5 minutes from now
    render(
      <PanelFooter version="0.0.0" autoUpdateNextAt={futureTime} {...footerProps} />
    )
    expect(screen.getByText("Next update in 5m")).toBeTruthy()
  })

  it("shows countdown in seconds when < 60 seconds", () => {
    const futureTime = Date.now() + 30 * 1000 // 30 seconds from now
    render(
      <PanelFooter version="0.0.0" autoUpdateNextAt={futureTime} {...footerProps} />
    )
    expect(screen.getByText("Next update in 30s")).toBeTruthy()
  })

  it("triggers refresh when clicking countdown label", async () => {
    const futureTime = Date.now() + 5 * 60 * 1000 // 5 minutes from now
    const onRefreshAll = vi.fn()
    render(
      <PanelFooter
        version="0.0.0"
        autoUpdateNextAt={futureTime}
        onRefreshAll={onRefreshAll}
        {...footerProps}
      />
    )
    const button = screen.getByRole("button", { name: /Next update in/i })
    await userEvent.click(button)
    expect(onRefreshAll).toHaveBeenCalledTimes(1)
  })

  it("shows Paused when autoUpdateNextAt is null", () => {
    render(<PanelFooter version="0.0.0" autoUpdateNextAt={null} {...footerProps} />)
    expect(screen.getByText("Paused")).toBeTruthy()
  })

  it("always shows the version, never an update prompt", () => {
    render(<PanelFooter version="1.0.0" autoUpdateNextAt={null} {...footerProps} />)
    expect(screen.getByRole("button", { name: "OpenUsage 1.0.0" })).toBeTruthy()
    expect(screen.queryByText("Restart to update")).toBeNull()
    expect(screen.queryByRole("button", { name: "Updates soon" })).toBeNull()
  })

  it("opens About dialog when clicking version", async () => {
    function Harness() {
      const [showAbout, setShowAbout] = useState(false)
      return (
        <PanelFooter
          version="0.0.0"
          autoUpdateNextAt={null}
          showAbout={showAbout}
          onShowAbout={() => setShowAbout(true)}
          onCloseAbout={() => setShowAbout(false)}
        />
      )
    }

    render(<Harness />)
    await userEvent.click(screen.getByRole("button", { name: /OpenUsage/ }))
    expect(screen.getByText("Open source on")).toBeInTheDocument()

    // Close via Escape to exercise AboutDialog onClose path.
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByText("Open source on")).not.toBeInTheDocument()
  })
})
