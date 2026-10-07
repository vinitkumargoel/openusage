# Claude Accounts

> Reads [claude-swap](https://github.com/realiti4/claude-swap) (`cswap`). Its JSON output is versioned (`schemaVersion: 1`).

Every Claude Code login saved with `cswap add`, one row each, with a **Switch** button. Switching swaps the real Claude Code login (Keychain), so native features like Remote Control keep working. No API proxy.

## Overview

- **Source:** `cswap list --json`, run by the app (no tokens reach the plugin)
- **Overview card:** active account's Session (5h) and Weekly (7d), plus how many other accounts are ready
- **Detail page:** one row per account: name, email, `active` / `limit` / `expired` / `off` tag, 5h and 7d bars with reset times
- **Switch:** per-row button, plus **Switch to best** (most headroom). Runs `cswap switch <n|best> --json`
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
