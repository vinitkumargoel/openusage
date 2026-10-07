# Claude Accounts

> Reads [claude-swap](https://github.com/realiti4/claude-swap) (`cswap`). Its JSON output is versioned (`schemaVersion: 1`).

Every Claude Code login saved with `cswap add`, one row each, with a **Switch** button. Switching swaps the real Claude Code login (Keychain), so native features like Remote Control keep working. No API proxy.

## Overview

- **Source:** `cswap list --json`, run by the app (no tokens reach the plugin)
- **Overview card:** active account's Session (5h) and Weekly (7d), plus how many other accounts are ready
- **Detail page:**
  - Active account card: ring of what's left, session window (striped = time gone) with burn pace ("on pace for 67%" / "hits limit in ~20m"), weekly bar with a pace marker
  - Summary: accounts ready, 5h sessions free across the pool, next reset
  - One tile per other account: ring (outer 5h left, inner 7d left), headroom, resets, `best` / `limit` / `expired` / `off` tag, Switch. Filter (All / Ready / In use / Has 7d) and sort (Most left / Resets soonest / Slot)
  - Tap a tile or the active card for a sheet: both windows, weekly pace and projection, scoped limits (e.g. Fable), org, copy `cswap switch N`. Keys: ←/→, S, Esc
- **Switch:** per-tile button, plus **Switch to best** (ready account with most headroom). Runs `cswap switch <n> --json`. Undo shows for a few seconds after a switch
- **Burn pace** is worked out by the app (used ÷ share of the 5h window gone). Weekly pace and projection come from cswap
- **After a switch:** this card and the Claude card refresh right away. Running `claude` sessions follow in about 30s
- **Requires:** `cswap` in `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin`, with at least one saved account

## Setup

```bash
uv tool install claude-swap
claude              # log in to account 1, then exit
cswap add           # repeat /login + cswap add for each account
```

Enable **Claude Accounts** in Settings.

## Auto-switching

Not done by OpenUsage (it only refreshes every few minutes). Run `cswap auto` for that; this page shows the result.

## Errors

| Message | Fix |
|---|---|
| `cswap not installed` | `uv tool install claude-swap` |
| `No accounts saved` | Log in with `claude`, then `cswap add` |
| `cswap failed: ...` | cswap's own error; run `cswap list` in a terminal |
