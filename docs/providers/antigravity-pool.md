# Antigravity Pool

> Reads a self-hosted [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) relay. Management API shapes are unversioned and may change.

Aggregates every Antigravity account pooled behind a CLIProxy relay into one card. The [`antigravity`](antigravity.md) plugin reads the IDE on *this* machine; this one reads the accounts a relay routes through, and reports them as a single pooled quota.

Run both only if you want both. They read different things and will show different numbers.

## Overview

- **Source:** CLIProxyAPI management API (`/v0/management/*`)
- **Auth:** `X-Management-Key` header, from a config file you write
- **Quota:** fraction (0.0–1.0, where 1.0 = 100% remaining), per model group per window
- **Quota windows:** weekly and 5-hour, **per account** — they do not line up across the pool
- **Detail page:** pool card, KPIs and one tile per account (rings, request bars, status), driest first, with a detail sheet per account
- **Requires:** a reachable CLIProxy relay with at least one `antigravity` account

## Setup

Enable the plugin in Settings, then fill in **Settings → Plugin Settings → Antigravity Pool**:

| Field | Value |
|---|---|
| Relay URL | `http://<relay>:8317`. Comma-separate several to try in order, e.g. Tailscale first, then LAN: the first that answers is used and remembered |
| Management key | `MANAGEMENT_PASSWORD` from the relay's `.env` |

Saving writes the plugin's `config.json` (mode 600) and re-probes the card. The same file can be written by hand:

```
~/Library/Application Support/com.sunstory.openusage/plugins_data/antigravity-pool/config.json
```

```json
{
  "baseUrl": "http://100.105.72.106:8317, http://192.168.0.234:8317",
  "managementKey": "<MANAGEMENT_PASSWORD from the relay's .env>",
  "aliases": { "5e08993047420acb": "work-2" }
}
```

`aliases` is optional and maps an account's `auth_index` to the name shown on its row. Without it, an account is named by its Cloud Code project id minus the random suffix (`alien-agency-s1ttq` → `alien-agency`).

A trailing `/` or `/v1` on each address is stripped. Only a connection failure moves on to the next address; an HTTP error is the relay answering and is shown as-is. The key is sent as a header only — never in a URL, and request headers are not logged.

> **Five consecutive bad-key attempts ban your IP for ~30 minutes**, localhost included. The relay answers `{"error":"IP banned due to too many failed attempts..."}`, which the card shows verbatim. Don't guess the key.

## Endpoints

### auth-files — the pool roster

```
GET {baseUrl}/v0/management/auth-files
X-Management-Key: <key>
```

```jsonc
{
  "files": [
    {
      "provider": "antigravity",
      "auth_index": "5e08993047420acb",   // handle used to address the account
      "project_id": "alien-agency-s1ttq", // sent as `project` upstream
      "email": "...",                     // read but never stored or rendered
      "status": "active",
      "disabled": false,
      "unavailable": false,
      "success": 571,                     // cumulative, since relay start
      "failed": 4,
      "recent_requests": [ { "time": "09:30-09:40", "success": 1, "failed": 0 } ]
    }
  ]
}
```

One call, and it carries the roster, the request counters, the request history and the cooldowns. Non-`antigravity` entries are skipped.

`recent_requests` is 20 ten-minute buckets (~3h20m) stamped in the *relay's* local wall clock with no date. That is exactly the span the per-account rows draw, so the plugin keeps the buckets as they are and labels the axis in relay time.

`cooldowns` lists the timers the relay set after a 429 (`reason`, `retry_at`, `remaining_seconds`). An account with a live cooldown is shown as cooling and left out of the pool mean, because the relay will not route to it anyway.

### api-call — one account's quota

CLIProxy has no quota endpoint. It replays an upstream request instead, substituting the literal `$TOKEN$` with that account's OAuth token server-side. **No account token ever reaches the plugin.**

```
POST {baseUrl}/v0/management/api-call
X-Management-Key: <key>
```

```json
{
  "authIndex": "5e08993047420acb",
  "method": "POST",
  "url": "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "header": {
    "Authorization": "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)"
  },
  "data": "{\"project\":\"alien-agency-s1ttq\"}"
}
```

The reply wraps the upstream one; `body` is a JSON *string*:

```jsonc
{
  "status_code": 200,
  "body": "{\"groups\":[...]}"
}
```

```jsonc
{
  "groups": [
    {
      "displayName": "Gemini Models",
      "buckets": [
        { "bucketId": "gemini-weekly", "window": "weekly", "resetTime": "2026-09-01T17:44:31Z", "remainingFraction": 0.5984934 },
        { "bucketId": "gemini-5h",     "window": "5h",     "resetTime": "2026-09-01T08:30:32Z", "remainingFraction": 0.9364226 }
      ]
    },
    {
      "displayName": "Claude and GPT models",
      "buckets": [
        { "bucketId": "3p-weekly", "window": "weekly", "remainingFraction": 1 },
        { "bucketId": "3p-5h",     "window": "5h",     "remainingFraction": 1 }
      ]
    }
  ]
}
```

`bucketId` is the discriminator — display names are prose and vary. `3p` is third-party: Claude and GPT.

## What the card shows

| Line | Scope | Meaning |
|---|---|---|
| Gemini weekly | overview | Mean remaining across live accounts; counts down to the **earliest reset still ahead**. A cached reading whose account stopped answering keeps a reset instant that eventually passes, and a passed instant is skipped |
| Gemini 5h | overview | Same, 5-hour window |
| Pool | overview | Account count, with a subtitle when some are offline, cooling, unreachable, or not yet sampled |
| Accounts | detail | The pool view (below): pool card, KPIs, one tile per account, weekly refills, a detail sheet per account. Replaces the overview lines on the detail page |
| Requests | detail | Daily request count |

Card badge reads `CLIProxy`, so a pooled card is never mistaken for a local one.

### Why the mean

Requests are handed out round-robin, so the pool behaves like one account holding the average of what its members have left. Measured on a 9-account relay: accounts sharing a reset instant reported `remainingFraction` identical to four decimal places.

Disabled and unavailable accounts are left out of the mean and counted in the `Pool` line instead. Free-tier accounts have no 5h bucket at all, so the Gemini 5h mean is over the accounts that have one — which can be fewer than the `Pool` count.

### The pool view

- **Pool card:** ring of the Gemini 5h mean (inner ring weekly). 5h bar with stripes for time gone since the earliest reset's window began, and either the first live account to run dry at its current rate ("carbon-creek dry ~9m") or the pool's own pace. Weekly bar with an even-spend marker. Claude & GPT weekly and 5h means underneath (resets on hover)
- **KPIs:** live accounts (one dot per account, red when cooling or offline), pool error rate (worst account on hover, red dot for an account failing over twice the pool rate), countdown to the next weekly refill
- **Tiles:** name, tag (`cool`, `off`, `model` = a model is parked, `free` = no 5h bucket, `…` = not sampled yet), ring of what's left, 5h and weekly used, status (`dry ~1h 4m`, `cooling · 41m`, `idle · full`, `wk only`), the account's last ~3h20m of requests on one shared scale (failures in red), next reset and request count
- **Filters / sort:** All, Live, Low (under 25% left), Issues (not live, or a model parked). Driest (the plugin's order), Most left, Busiest, Name
- **Sheet** (tap a tile): Gemini 5h and weekly, the 5h window and weekly pace, a bigger request chart, Claude & GPT windows, recent and lifetime ok/failed with the error rate, cooldown reason and time, parked models, weekly cohort, when the quota was sampled, token refresh, date it joined the pool, project and auth index. ←/→ and Esc work
- Email addresses are never passed to the app

Accounts are ordered driest first: cooling, then by 5h left (weekly stands in for free tier), then unsampled, then offline. Every account's request buckets sit on one shared time grid (the longest series in the pool), zero-filled before a later start.

### Reset cohorts

Weekly windows start whenever an account was first used, so a pool has several. Accounts whose resets are within an hour of each other are grouped into a cohort — measured as the gap between them, so two resets twenty seconds either side of the half hour are one cohort, not two — and the Weekly refills list only appears when there is more than one — a single cohort is already described by the weekly bar's own countdown.

This is the difference between "73% left" and knowing that six accounts refill tonight and the other three not until Friday.

### Fan-out

One quota call per account, ~1.5s each, against a 30s probe deadline. Live accounts are read before cooling ones, because only live accounts feed the pool mean. Every probe refreshes the whole pool (up to **9** accounts) and stops fanning out after **16s**, merging anything left from disk; those accounts are picked up first on the next probe. A reading younger than **4 minutes** is not re-read, so a manual refresh right after a scheduled one does not hit Google twice. A refresh that fails keeps showing the cached reading.

### The heatmap

Daily counts come from differencing CLIProxy's cumulative per-account `success` counter between probes — it arrives free with the roster call, so nothing extra is fetched and nothing is polled.

Quota percentages are deliberately *not* the source: accounts share reset instants, so every reset would read as a pool-wide spike.

An account seen for the first time contributes nothing, because its lifetime total would spike the day it joined. A counter that went backwards means the relay restarted, so the increment is meaningless and the counter's current value is taken as today's instead. Because this runs before the quota fan-out, history keeps accruing even while the quota API is down.

## Plugin Strategy

1. Read `config.json` from the plugin data dir; fail loudly pointing at Settings if it is missing.
2. `GET /v0/management/auth-files` → the `antigravity` accounts with their request buckets and cooldowns, sorted by `auth_index`.
3. Fold the `success` counters into today's request bucket; drop accounts that left the pool.
4. Fetch quota for every account whose cached reading is over 4 minutes old, oldest first, until the 16s budget is spent.
5. Persist state to `pool-state.json`, then aggregate cached and fresh readings together.
6. If nothing has ever been sampled, error with the last upstream failure.

## Files

Both live in the plugin data dir shown under [Setup](#setup).

- `config.json` — written by Settings → Plugin Settings (or by hand); base URL, management key, optional aliases
- `pool-state.json` — per-account readings, request counters, daily history (400-day retention)

Only `auth_index` is stored. Emails are read off the roster and dropped.
