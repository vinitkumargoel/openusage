# Antigravity Pool

> Reads a self-hosted [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) relay. Management API shapes are unversioned and may change.

Aggregates every Antigravity account pooled behind a CLIProxy relay into one card. The [`antigravity`](antigravity.md) plugin reads the IDE on *this* machine; this one reads the accounts a relay routes through, and reports them as a single pooled quota.

Run both only if you want both. They read different things and will show different numbers.

## Overview

- **Source:** CLIProxyAPI management API (`/v0/management/*`)
- **Auth:** `X-Management-Key` header, from a config file you write
- **Quota:** fraction (0.0–1.0, where 1.0 = 100% remaining), per model group per window
- **Quota windows:** weekly and 5-hour, **per account** — they do not line up across the pool
- **Requires:** a reachable CLIProxy relay with at least one `antigravity` account

## Setup

Enable the plugin in Settings — it is disabled by default. The first probe creates its data directory and then errors with the path, so the order is: enable, read the path off the card, write the file, refresh.

```
~/Library/Application Support/com.sunstory.openusage/plugins_data/antigravity-pool/config.json
```

```json
{
  "baseUrl": "http://relay.example:8317",
  "managementKey": "<MANAGEMENT_PASSWORD from the relay's .env>"
}
```

A trailing `/` or `/v1` on `baseUrl` is stripped. The key is sent as a header only — never in a URL, and request headers are not logged.

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

One call, and it carries both the roster and the request counters. Non-`antigravity` entries are skipped.

`recent_requests` is only 20 buckets (~3h20m) and stamped in the *relay's* local wall clock with no date, so the plugin ignores it.

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
| Gemini weekly | overview | Mean remaining across live accounts; counts down to the **earliest** reset in the pool |
| Gemini 5h | overview | Same, 5-hour window |
| Pool | overview | Account count, with a subtitle when some are offline, unreachable, or not yet sampled |
| *N* accounts | detail | One row per reset cohort — only when the windows are actually skewed |
| Claude & GPT | detail | One line, because it is usually untouched |
| Rotation | detail | Pool error rate; names an account failing well above it, red when one is offline |
| Requests | detail | Daily request count |

Card badge reads `CLIProxy`, so a pooled card is never mistaken for a local one.

### Why the mean

Requests are handed out round-robin, so the pool behaves like one account holding the average of what its members have left. Measured on a 9-account relay: accounts sharing a reset instant reported `remainingFraction` identical to four decimal places.

Disabled and unavailable accounts are left out of the mean and counted in the `Pool` line instead.

### Reset cohorts

Weekly windows start whenever an account was first used, so a pool has several. Accounts resetting in the same hour are grouped into a cohort, and the rows only appear when there is more than one — a single cohort is already described by the weekly bar's own countdown.

This is the difference between "73% left" and knowing that six accounts refill tonight and the other three not until Friday.

### Staggered fan-out

One quota call per account, ~1.6s each, against a 30s probe deadline. So each probe refreshes at most **4** accounts, stops fanning out after **12s**, and merges the rest from disk. Accounts are re-read when their cached reading is over **40 minutes** old, which at the default 15-minute interval sweeps a 9-account pool in ~30 minutes. A refresh that fails keeps showing the cached reading.

### The heatmap

Daily counts come from differencing CLIProxy's cumulative per-account `success` counter between probes — it arrives free with the roster call, so nothing extra is fetched and nothing is polled.

Quota percentages are deliberately *not* the source: accounts share reset instants, so every reset would read as a pool-wide spike.

Two increments are never counted: an account seen for the first time (its lifetime total would spike the day it joined) and a counter that went backwards (the relay restarted, so what is there now is today's). Because this runs before the quota fan-out, history keeps accruing even while the quota API is down.

## Plugin Strategy

1. Read `config.json` from the plugin data dir; fail loudly with the directory path if it is missing.
2. `GET /v0/management/auth-files` → the `antigravity` accounts, sorted by `auth_index` so the stagger is deterministic.
3. Fold the `success` counters into today's request bucket; drop accounts that left the pool.
4. Pick up to 4 accounts whose cached reading is over 40 minutes old, oldest first, and fetch each one's quota until the 12s budget is spent.
5. Persist state to `pool-state.json`, then aggregate cached and fresh readings together.
6. If nothing has ever been sampled, error with the last upstream failure.

## Files

Both live in the plugin data dir shown under [Setup](#setup).

- `config.json` — you write this; base URL and management key
- `pool-state.json` — per-account readings, request counters, daily history (400-day retention)

Only `auth_index` is stored. Emails are read off the roster and dropped.
