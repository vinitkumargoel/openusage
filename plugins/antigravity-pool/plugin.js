(function () {
  // Aggregates every Antigravity account pooled behind a CLIProxyAPI relay into
  // one card. CLIProxy has no quota endpoint of its own, so per account we POST
  // /v0/management/api-call and the relay replays Google's
  // retrieveUserQuotaSummary with that account's OAuth token — it substitutes the
  // literal `$TOKEN$` server-side, so no account token ever reaches this plugin.

  var AUTH_FILES_PATH = "/v0/management/auth-files"
  var API_CALL_PATH = "/v0/management/api-call"
  var QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
  var UPSTREAM_UA = "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)"
  var TOKEN_PLACEHOLDER = "Bearer $TOKEN$"

  var HOUR_MS = 60 * 60 * 1000
  var FIVE_HOUR_MS = 5 * HOUR_MS
  var WEEK_MS = 7 * 24 * HOUR_MS

  // Fan-out budget. Measured against a 9-account relay: ~1.5s per account,
  // ~14s for the pool — under the host's 30s probe deadline. Every account has
  // its own row now, so each probe refreshes the whole pool and only falls back
  // to disk when the budget runs out or a call fails. The short TTL just stops
  // a manual refresh right after a scheduled one from hitting Google twice.
  var MAX_PER_PROBE = 9
  var FANOUT_BUDGET_MS = 16000
  var ACCOUNT_TTL_MS = 4 * 60 * 1000
  var LIST_TIMEOUT_MS = 8000
  var QUOTA_TIMEOUT_MS = 8000

  // CLIProxy keeps 20 ten-minute request buckets per account (~3h20m).
  var MAX_BUCKETS = 20

  var RETENTION_DAYS = 400

  // Google returns one bucket per window per model group. `3p` is Claude + GPT.
  var BUCKET_SLOTS = {
    "gemini-weekly": "gemWeek",
    "gemini-5h": "gemFive",
    "3p-weekly": "restWeek",
    "3p-5h": "restFive",
  }

  function numOf(value) {
    var n = Number(value)
    return Number.isFinite(n) ? n : 0
  }

  function pct(fraction) {
    return Math.round(fraction * 100)
  }

  // Must match the app's formatDayKey (local date) so heatmap cells line up.
  function dayKey(date) {
    var month = date.getMonth() + 1
    var day = date.getDate()
    return date.getFullYear() + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day
  }

  // --- Config ---

  // Written by Settings → Plugin Settings (or by hand). `aliases` is optional:
  // auth_index → display name, for people who prefer "work-2" to "alien-agency".
  var SETUP_HINT = "Add the relay URL and management key in Settings → Plugin Settings"

  // `baseUrl` may list several relays' addresses ("tailscale, lan"): the first
  // one that answers is used, so the card works at home with Tailscale off and
  // away from home with it on. Only connection failures move to the next one;
  // an HTTP error is the relay talking and is surfaced as-is.
  function loadConfig(ctx) {
    var path = ctx.app.pluginDataDir + "/config.json"
    if (!ctx.host.fs.exists(path)) throw SETUP_HINT
    var stored = ctx.util.tryParseJson(ctx.host.fs.readText(path))
    var raw = stored && typeof stored.baseUrl === "string" ? stored.baseUrl : ""
    var key = stored && typeof stored.managementKey === "string" ? stored.managementKey.trim() : ""
    var baseUrls = []
    var parts = raw.split(/[\s,]+/)
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim()
      if (!part) continue
      if (!/^https?:\/\//i.test(part)) throw "Relay URL must start with http:// or https://"
      baseUrls.push(part.replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, ""))
    }
    if (baseUrls.length === 0 || !key) throw SETUP_HINT
    var aliases = stored.aliases && typeof stored.aliases === "object" ? stored.aliases : {}
    return { baseUrls: baseUrls, key: key, aliases: aliases }
  }

  function accountName(account, aliases) {
    var alias = aliases[account.authIndex]
    if (typeof alias === "string" && alias.trim()) return alias.trim()
    // "alien-agency-s1ttq" → "alien-agency": the words are memorable, the suffix is noise.
    var project = account.projectId.replace(/-[a-z0-9]{5}$/i, "")
    return project || "#" + account.authIndex.slice(0, 6)
  }

  // CLIProxy answers failures as { "error": "..." }. Surfacing it verbatim is what
  // tells you the key is wrong versus the IP being banned for failed attempts.
  function statusError(ctx, prefix, status, bodyText) {
    var body = ctx.util.tryParseJson(bodyText)
    var message = body && typeof body.error === "string" ? body.error : ""
    return prefix + " " + status + (message ? ": " + message : "")
  }

  // --- Relay ---

  // Tries the last relay address that worked first, then the rest in order.
  function fetchAccounts(ctx, cfg, preferredUrl) {
    var order = []
    if (preferredUrl && cfg.baseUrls.indexOf(preferredUrl) >= 0) order.push(preferredUrl)
    for (var u = 0; u < cfg.baseUrls.length; u++) {
      if (order.indexOf(cfg.baseUrls[u]) < 0) order.push(cfg.baseUrls[u])
    }
    var resp = null
    for (var o = 0; o < order.length; o++) {
      try {
        resp = ctx.host.http.request({
          method: "GET",
          url: order[o] + AUTH_FILES_PATH,
          headers: { Accept: "application/json", "X-Management-Key": cfg.key },
          timeoutMs: LIST_TIMEOUT_MS,
        })
        cfg.baseUrl = order[o]
        break
      } catch (e) {
        ctx.host.log.info("relay unreachable at " + order[o] + ", trying next: " + String(e))
      }
    }
    if (!resp) throw "Cannot reach CLIProxy at " + cfg.baseUrls.join(", ")
    if (resp.status < 200 || resp.status >= 300) {
      throw statusError(ctx, "CLIProxy", resp.status, resp.bodyText)
    }
    var data = ctx.util.tryParseJson(resp.bodyText)
    var files = data && Array.isArray(data.files) ? data.files : (Array.isArray(data) ? data : null)
    if (!files) throw "CLIProxy auth-files returned an unexpected shape"

    var accounts = []
    for (var i = 0; i < files.length; i++) {
      var file = files[i]
      if (!file || typeof file !== "object") continue
      if (String(file.provider || "").toLowerCase() !== "antigravity") continue
      var authIndex = String(file.auth_index || "")
      if (!authIndex) continue
      accounts.push({
        authIndex: authIndex,
        projectId: String(file.project_id || ""),
        offline: file.disabled === true || file.unavailable === true,
        joinedAt: typeof file.created_at === "string" ? file.created_at : "",
        refreshedAt: typeof file.last_refresh === "string" ? file.last_refresh : "",
        success: numOf(file.success),
        failed: numOf(file.failed),
        buckets: parseBuckets(file.recent_requests),
        cooling: parseCooldown(file.cooldowns),
        modelCooldowns: parseModelCooldowns(file.cooldowns),
      })
    }
    if (accounts.length === 0) throw "No Antigravity accounts in the CLIProxy pool"
    accounts.sort(function (a, b) {
      return a.authIndex < b.authIndex ? -1 : a.authIndex > b.authIndex ? 1 : 0
    })
    return accounts
  }

  // 20 ten-minute buckets labelled "HH:MM-HH:MM" in the relay's own wall
  // clock, no date. Kept as-is: the row shows the last ~3h20m, nothing older.
  function parseBuckets(raw) {
    if (!Array.isArray(raw)) return []
    var out = []
    for (var i = 0; i < raw.length; i++) {
      var entry = raw[i]
      if (!entry || typeof entry !== "object") continue
      out.push({
        time: String(entry.time || ""),
        success: Math.max(0, numOf(entry.success)),
        failed: Math.max(0, numOf(entry.failed)),
      })
    }
    return out.length > MAX_BUCKETS ? out.slice(out.length - MAX_BUCKETS) : out
  }

  // The relay parks an account after a 429 and says until when. That is the
  // one signal that flags a dead account before Google's fraction moves.
  // Model-scoped cooldowns (scope: "model") only park that specific model
  // (e.g. image generation) while the account still serves other models.
  function parseCooldown(raw) {
    if (!Array.isArray(raw)) return null
    var best = null
    for (var i = 0; i < raw.length; i++) {
      var entry = raw[i]
      if (!entry || typeof entry !== "object") continue
      if (entry.scope === "model") continue
      var untilMs = typeof entry.retry_at === "string" ? Date.parse(entry.retry_at) : NaN
      if (!Number.isFinite(untilMs)) continue
      if (!best || untilMs > best.untilMs) {
        best = { untilMs: untilMs, reason: String(entry.reason || "cooldown") }
      }
    }
    return best
  }

  function parseModelCooldowns(raw) {
    if (!Array.isArray(raw)) return []
    var models = []
    for (var i = 0; i < raw.length; i++) {
      var entry = raw[i]
      if (!entry || typeof entry !== "object") continue
      if (entry.scope !== "model") continue
      var untilMs = typeof entry.retry_at === "string" ? Date.parse(entry.retry_at) : NaN
      if (!Number.isFinite(untilMs)) continue
      var key = String(entry.model_key || entry.model || "").trim()
      if (key) models.push({ model: key, untilMs: untilMs })
    }
    return models
  }

  function parseQuota(body) {
    var groups = body && Array.isArray(body.groups) ? body.groups : []
    var quota = null
    for (var g = 0; g < groups.length; g++) {
      var buckets = groups[g] && Array.isArray(groups[g].buckets) ? groups[g].buckets : []
      for (var b = 0; b < buckets.length; b++) {
        var bucket = buckets[b]
        if (!bucket || typeof bucket.remainingFraction !== "number") continue
        var slot = BUCKET_SLOTS[String(bucket.bucketId || "")]
        if (!slot) continue
        if (!quota) quota = {}
        quota[slot] = Math.max(0, Math.min(1, bucket.remainingFraction))
        if (typeof bucket.resetTime === "string" && bucket.resetTime) {
          quota[slot + "Reset"] = bucket.resetTime
        }
      }
    }
    return quota
  }

  function fetchQuota(ctx, cfg, account) {
    var resp
    try {
      resp = ctx.host.http.request({
        method: "POST",
        url: cfg.baseUrl + API_CALL_PATH,
        headers: { "Content-Type": "application/json", "X-Management-Key": cfg.key },
        bodyText: JSON.stringify({
          authIndex: account.authIndex,
          method: "POST",
          url: QUOTA_URL,
          header: {
            Authorization: TOKEN_PLACEHOLDER,
            "Content-Type": "application/json",
            "User-Agent": UPSTREAM_UA,
          },
          data: JSON.stringify({ project: account.projectId }),
        }),
        timeoutMs: QUOTA_TIMEOUT_MS,
      })
    } catch (e) {
      return { ok: false, error: "request failed: " + String(e) }
    }
    if (resp.status < 200 || resp.status >= 300) {
      return { ok: false, error: statusError(ctx, "relay", resp.status, resp.bodyText) }
    }
    var envelope = ctx.util.tryParseJson(resp.bodyText)
    if (!envelope) return { ok: false, error: "relay did not return JSON" }
    var upstream = numOf(envelope.status_code)
    if (upstream < 200 || upstream >= 300) return { ok: false, error: "quota API " + upstream }
    var body = typeof envelope.body === "string" ? ctx.util.tryParseJson(envelope.body) : envelope.body
    var quota = parseQuota(body)
    if (!quota) return { ok: false, error: "no quota buckets" }
    return { ok: true, quota: quota }
  }

  // --- State ---

  function statePath(ctx) {
    return ctx.app.pluginDataDir + "/pool-state.json"
  }

  function loadState(ctx) {
    var path = statePath(ctx)
    var present = ctx.host.fs.exists(path)
    var stored = present ? ctx.util.tryParseJson(ctx.host.fs.readText(path)) : null
    if (!stored || typeof stored !== "object") {
      // Starting from scratch loses the heatmap's history, so say so rather than
      // let 400 days vanish quietly after a crash truncated the file.
      if (present) ctx.host.log.error("pool-state.json is unreadable; request history restarts from today")
      return { accounts: {}, counters: {}, days: {} }
    }
    return {
      accounts: stored.accounts && typeof stored.accounts === "object" ? stored.accounts : {},
      counters: stored.counters && typeof stored.counters === "object" ? stored.counters : {},
      days: stored.days && typeof stored.days === "object" ? stored.days : {},
      baseUrl: typeof stored.baseUrl === "string" ? stored.baseUrl : undefined,
    }
  }

  function saveState(ctx, state) {
    try {
      ctx.host.fs.writeText(statePath(ctx), JSON.stringify(state))
    } catch (e) {
      ctx.host.log.warn("failed to persist pool state: " + String(e))
    }
  }

  function pruneAccounts(state, accounts) {
    var known = {}
    for (var i = 0; i < accounts.length; i++) known[accounts[i].authIndex] = true
    var keys = Object.keys(state.accounts)
    for (var k = 0; k < keys.length; k++) {
      if (!known[keys[k]]) delete state.accounts[keys[k]]
    }
  }

  // CLIProxy's per-account `success` counter is cumulative, so a day's request
  // count is the sum of its increments between probes. Two cases must not become
  // a delta: an account seen for the first time (adding its lifetime total would
  // spike the day it joined the pool) and a counter that went backwards (the
  // relay restarted, so what is there now is today's).
  //
  // Quota percentages are deliberately not the source here: six accounts share
  // one weekly reset instant, so every reset would read as a pool-wide spike.
  function recordRequests(state, accounts, now) {
    var counters = {}
    var delta = 0
    for (var i = 0; i < accounts.length; i++) {
      var account = accounts[i]
      counters[account.authIndex] = account.success
      var previous = state.counters[account.authIndex]
      if (typeof previous !== "number") continue
      delta += account.success >= previous ? account.success - previous : account.success
    }
    state.counters = counters
    if (delta > 0) {
      var key = dayKey(now)
      state.days[key] = (state.days[key] || 0) + delta
    }
    var cutoffKey = dayKey(new Date(now.getTime() - RETENTION_DAYS * 24 * HOUR_MS))
    var keys = Object.keys(state.days)
    for (var k = 0; k < keys.length; k++) {
      if (keys[k] <= cutoffKey) delete state.days[keys[k]]
    }
  }

  function selectDue(accounts, state, nowMs) {
    var due = []
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].offline) continue
      var cached = state.accounts[accounts[i].authIndex]
      var age = cached && typeof cached.fetchedAtMs === "number"
        ? nowMs - cached.fetchedAtMs
        : Number.MAX_SAFE_INTEGER
      if (age < ACCOUNT_TTL_MS) continue
      var cooling = accounts[i].cooling && accounts[i].cooling.untilMs > nowMs ? 1 : 0
      due.push({ account: accounts[i], age: age, cooling: cooling })
    }
    // Live accounts first: they are the ones the mean is built from, so on a cold
    // start the budget must not be spent on parked ones.
    due.sort(function (a, b) {
      if (a.cooling !== b.cooling) return a.cooling - b.cooling
      if (a.age !== b.age) return b.age - a.age
      return a.account.authIndex < b.account.authIndex ? -1 : 1
    })
    var picked = []
    for (var j = 0; j < due.length && j < MAX_PER_PROBE; j++) picked.push(due[j].account)
    return picked
  }

  // --- Aggregation ---

  // Cooling accounts are still sampled (Google's fraction is what says how
  // much they have left) but a parked account contributes nothing to the pool
  // right now, so it stays out of the mean like an offline one.
  // When every account is cooling, fall back to all cached entries so the card
  // displays quota and reset countdowns instead of failing.
  function sampledEntries(accounts, state, nowMs) {
    var liveEntries = []
    var allEntries = []
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].offline) continue
      var cached = state.accounts[accounts[i].authIndex]
      if (!cached) continue
      allEntries.push(cached)
      if (accounts[i].cooling && accounts[i].cooling.untilMs > nowMs) continue
      liveEntries.push(cached)
    }
    return liveEntries.length > 0 ? liveEntries : allEntries
  }

  // Requests are handed to accounts round-robin, so the pool behaves like one
  // account holding the mean of what its members have left.
  function meanOf(entries, key) {
    var sum = 0
    var count = 0
    for (var i = 0; i < entries.length; i++) {
      if (typeof entries[i][key] === "number") {
        sum += entries[i][key]
        count += 1
      }
    }
    return count > 0 ? sum / count : null
  }

  // The earliest reset still ahead of us is when the pool's capacity next
  // changes. A cached reading whose account stopped answering keeps its old
  // reset instant, and that instant goes stale — counting down to it would show
  // a countdown that already expired.
  function earliestReset(entries, key, nowMs) {
    var best = null
    for (var i = 0; i < entries.length; i++) {
      var iso = entries[i][key]
      if (typeof iso !== "string") continue
      var ms = Date.parse(iso)
      if (!Number.isFinite(ms)) continue
      if (ms <= nowMs) continue
      if (best === null || ms < best.ms) best = { ms: ms, iso: iso }
    }
    return best
  }

  // Accounts resetting on the same hour form a cohort. On a 9-account relay the
  // weekly windows collapsed onto two instants 3.5 days apart, so two rows say
  // what nine would have — and they say when capacity actually comes back.
  function cohortsOf(entries) {
    var points = []
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      if (typeof entry.gemWeek !== "number") continue
      var ms = typeof entry.gemWeekReset === "string" ? Date.parse(entry.gemWeekReset) : NaN
      if (!Number.isFinite(ms)) continue
      points.push({ ms: ms, value: entry.gemWeek })
    }
    points.sort(function (a, b) { return a.ms - b.ms })
    // Grouped by how far apart the resets are, not by which side of the hour
    // they round to: two resets 20 seconds either side of :30 are one cohort.
    var cohorts = []
    var current = null
    for (var p = 0; p < points.length; p++) {
      if (current && points[p].ms - current.lastMs <= HOUR_MS) {
        current.sum += points[p].value
        current.count += 1
        current.lastMs = points[p].ms
        continue
      }
      current = { resetMs: points[p].ms, lastMs: points[p].ms, sum: points[p].value, count: 1 }
      cohorts.push(current)
    }
    return cohorts
  }

  // --- Lines ---

  function accountsLabel(count) {
    return count + (count === 1 ? " account" : " accounts")
  }

  function progressLine(ctx, label, fraction, reset, periodMs) {
    return ctx.line.progress({
      label: label,
      used: 100 - pct(fraction),
      limit: 100,
      format: { kind: "percent" },
      resetsAt: reset ? reset.iso : undefined,
      periodDurationMs: periodMs,
    })
  }

  // Failures hide inside a healthy-looking pool average: one account can be
  // failing several times the pool rate while every quota bar still reads fine.
  function errorRates(accounts) {
    var success = 0
    var failed = 0
    var worstRate = null
    for (var i = 0; i < accounts.length; i++) {
      var account = accounts[i]
      success += account.success
      failed += account.failed
      var total = account.success + account.failed
      if (total >= 50 && account.failed > 0) {
        var rate = account.failed / total
        if (worstRate === null || rate > worstRate) worstRate = rate
      }
    }
    if (success + failed === 0) return null
    return { pool: (failed / (success + failed)) * 100, worst: worstRate === null ? null : worstRate * 100 }
  }

  // --- Per-account rows ---

  // Driest first: cooling, then by what the 5h window has left (a free-tier
  // account has no 5h bucket, so its weekly stands in), then anything not yet
  // sampled, then offline.
  function accountRank(account, cached, nowMs) {
    if (account.cooling && account.cooling.untilMs > nowMs) return -1
    if (account.offline) return 3
    if (!cached) return 2
    if (typeof cached.gemFive === "number") return cached.gemFive
    if (typeof cached.gemWeek === "number") return cached.gemWeek
    return 2
  }

  // The x-axis is shared across rows, so every row has to be the same span of
  // relay time. The longest bucket series is the grid; a quieter account whose
  // series starts later is placed on it by bucket label and zero-filled before.
  function bucketGrid(accounts) {
    var grid = []
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].buckets.length > grid.length) grid = accounts[i].buckets
    }
    var slots = []
    var index = {}
    for (var g = 0; g < grid.length; g++) {
      slots.push(grid[g].time)
      index[grid[g].time] = g
    }
    return { slots: slots, index: index }
  }

  function windowOf(fraction, resetIso, periodMs) {
    if (typeof fraction !== "number") return undefined
    var win = { left: pct(fraction), periodMs: periodMs }
    if (typeof resetIso === "string" && resetIso) win.resetsAt = resetIso
    return win
  }

  function isoOf(ms) {
    return new Date(ms).toISOString()
  }

  function poolAccount(ctx, account, cached, aliases, nowMs, grid) {
    var requests = []
    var failures = []
    for (var g = 0; g < grid.slots.length; g++) {
      requests.push(0)
      failures.push(0)
    }
    var offGrid = 0
    for (var i = 0; i < account.buckets.length; i++) {
      var slot = grid.index[account.buckets[i].time]
      if (typeof slot !== "number") {
        offGrid += 1
        continue
      }
      requests[slot] += account.buckets[i].success
      failures[slot] += account.buckets[i].failed
    }
    if (offGrid > 0) {
      ctx.host.log.warn(
        "account " + account.authIndex.slice(0, 6) + " has " + offGrid +
        " request buckets outside the pool's time grid; they are not drawn"
      )
    }
    var cooling = account.cooling && account.cooling.untilMs > nowMs ? account.cooling : null
    var out = {
      id: account.authIndex,
      name: accountName(account, aliases),
      state: cooling ? "cooling" : account.offline ? "offline" : cached ? "live" : "sampling",
      requests: requests,
      failures: failures,
      ok: account.success,
      failed: account.failed,
    }
    if (cooling) out.cooldown = { reason: cooling.reason, until: isoOf(cooling.untilMs) }
    var models = []
    var seen = {}
    for (var m = 0; m < account.modelCooldowns.length; m++) {
      var mc = account.modelCooldowns[m]
      if (mc.untilMs <= nowMs || seen[mc.model]) continue
      seen[mc.model] = true
      models.push({ model: mc.model, until: isoOf(mc.untilMs) })
    }
    if (models.length > 0) out.models = models
    if (cached) {
      out.five = windowOf(cached.gemFive, cached.gemFiveReset, FIVE_HOUR_MS)
      out.week = windowOf(cached.gemWeek, cached.gemWeekReset, WEEK_MS)
      out.restFive = windowOf(cached.restFive, cached.restFiveReset, FIVE_HOUR_MS)
      out.restWeek = windowOf(cached.restWeek, cached.restWeekReset, WEEK_MS)
      if (typeof cached.fetchedAtMs === "number") out.sampledAt = isoOf(cached.fetchedAtMs)
      // A free-tier account has no 5h bucket; its weekly is all it has.
      if (!out.five && out.week) out.tag = "free"
    }
    if (models.length > 0 && !out.tag) out.tag = "model"
    if (account.projectId) out.project = account.projectId
    if (account.joinedAt) out.joinedAt = account.joinedAt
    if (account.refreshedAt) out.refreshedAt = account.refreshedAt
    return out
  }

  function meanWindow(entries, key, nowMs, periodMs) {
    var mean = meanOf(entries, key)
    if (mean === null) return undefined
    var reset = earliestReset(entries, key + "Reset", nowMs)
    return windowOf(mean, reset ? reset.iso : null, periodMs)
  }

  // Everything the detail page shows: pool means, counts, error rates, weekly
  // cohorts and one entry per account, driest first.
  function poolLine(ctx, accounts, entries, state, aliases, failures, now) {
    var nowMs = now.getTime()
    var ranked = []
    for (var i = 0; i < accounts.length; i++) {
      var cached = state.accounts[accounts[i].authIndex] || null
      ranked.push({ account: accounts[i], cached: cached, rank: accountRank(accounts[i], cached, nowMs) })
    }
    ranked.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank
      return a.account.authIndex < b.account.authIndex ? -1 : 1
    })
    var grid = bucketGrid(accounts)
    var list = []
    var counts = { total: accounts.length, live: 0, cooling: 0, offline: 0, sampled: entries.length, unreachable: failures }
    for (var r = 0; r < ranked.length; r++) {
      var item = poolAccount(ctx, ranked[r].account, ranked[r].cached, aliases, nowMs, grid)
      if (item.state === "cooling") counts.cooling += 1
      else if (item.state === "offline") counts.offline += 1
      else counts.live += 1
      list.push(item)
    }
    var pool = {
      five: meanWindow(entries, "gemFive", nowMs, FIVE_HOUR_MS),
      week: meanWindow(entries, "gemWeek", nowMs, WEEK_MS),
      restFive: meanWindow(entries, "restFive", nowMs, FIVE_HOUR_MS),
      restWeek: meanWindow(entries, "restWeek", nowMs, WEEK_MS),
      counts: counts,
      cohorts: [],
      slots: grid.slots,
      accounts: list,
    }
    var rates = errorRates(accounts)
    if (rates) {
      pool.errorRate = rates.pool
      if (rates.worst !== null) pool.worstRate = rates.worst
    }
    var cohorts = cohortsOf(entries)
    for (var c = 0; c < cohorts.length; c++) {
      pool.cohorts.push({ count: cohorts[c].count, left: pct(cohorts[c].sum / cohorts[c].count), resetsAt: isoOf(cohorts[c].resetMs) })
    }
    if (grid.slots.length > 0) {
      var first = grid.slots[0]
      var last = grid.slots[grid.slots.length - 1]
      pool.axis = first.split("-")[0] + " → " + (last.split("-")[1] || last.split("-")[0]) + " relay time · 10-min buckets"
    }
    return ctx.line.pool({ label: "Accounts", pool: pool })
  }

  function heatmapLine(ctx, days) {
    var keys = Object.keys(days)
    keys.sort()
    var buckets = []
    for (var i = 0; i < keys.length; i++) {
      if (days[keys[i]] > 0) buckets.push({ date: keys[i], value: days[keys[i]] })
    }
    if (buckets.length === 0) return null
    return ctx.line.heatmap({
      label: "Requests",
      days: buckets,
      format: { kind: "count", suffix: "req" },
    })
  }

  function buildLines(ctx, cfg, accounts, entries, state, failures, now) {
    var lines = []

    var gemWeek = meanOf(entries, "gemWeek")
    if (gemWeek !== null) {
      lines.push(progressLine(ctx, "Gemini weekly", gemWeek, earliestReset(entries, "gemWeekReset", now.getTime()), WEEK_MS))
    }
    var gemFive = meanOf(entries, "gemFive")
    if (gemFive !== null) {
      lines.push(progressLine(ctx, "Gemini 5h", gemFive, earliestReset(entries, "gemFiveReset", now.getTime()), FIVE_HOUR_MS))
    }

    var live = 0
    var cooling = 0
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].offline) continue
      if (accounts[i].cooling && accounts[i].cooling.untilMs > now.getTime()) cooling += 1
      else live += 1
    }
    var offline = accounts.length - live - cooling
    var poolSubtitle = null
    if (offline > 0) poolSubtitle = offline + " offline"
    else if (cooling > 0) poolSubtitle = cooling + " cooling"
    else if (failures > 0) poolSubtitle = failures + " unreachable"
    else if (entries.length < live) poolSubtitle = entries.length + " sampled"
    lines.push(ctx.line.text({
      label: "Pool",
      value: accountsLabel(accounts.length),
      subtitle: poolSubtitle || undefined,
    }))

    lines.push(poolLine(ctx, accounts, entries, state, cfg.aliases, failures, now))

    var heatmap = heatmapLine(ctx, state.days)
    if (heatmap) lines.push(heatmap)

    return lines
  }

  // --- Probe ---

  function probe(ctx) {
    var startedMs = Date.now()
    var cfg = loadConfig(ctx)
    var state = loadState(ctx)
    var accounts = fetchAccounts(ctx, cfg, state.baseUrl)
    state.baseUrl = cfg.baseUrl

    var now = new Date()
    recordRequests(state, accounts, now)
    pruneAccounts(state, accounts)

    var due = selectDue(accounts, state, now.getTime())
    var failures = 0
    var lastError = null
    for (var i = 0; i < due.length; i++) {
      if (i > 0 && Date.now() - startedMs >= FANOUT_BUDGET_MS) {
        ctx.host.log.info("fan-out budget spent after " + i + " of " + due.length + " accounts")
        break
      }
      var result = fetchQuota(ctx, cfg, due[i])
      if (!result.ok) {
        failures += 1
        lastError = result.error
        ctx.host.log.warn("quota fetch failed: " + result.error)
        continue
      }
      result.quota.fetchedAtMs = Date.now()
      state.accounts[due[i].authIndex] = result.quota
    }

    var entries = sampledEntries(accounts, state, now.getTime())
    saveState(ctx, state)

    if (entries.length === 0) {
      throw lastError ? "No quota returned (" + lastError + ")" : "No quota returned yet"
    }

    return { plan: "CLIProxy", lines: buildLines(ctx, cfg, accounts, entries, state, failures, now) }
  }

  globalThis.__openusage_plugin = { id: "antigravity-pool", probe: probe }
})()
