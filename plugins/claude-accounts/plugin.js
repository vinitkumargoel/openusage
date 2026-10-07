(function () {
  // Every Claude Code login stored by claude-swap (`cswap`), one row each.
  // The host runs `cswap list --json` for us; no token ever reaches this
  // plugin. Switching happens in the app (Switch button), never here.

  var INSTALL_HINT = "cswap not installed. Run: uv tool install claude-swap"
  var EMPTY_HINT = "No accounts saved. Log in with claude, then run: cswap add"
  var LIMIT_PCT = 90
  var FIVE_HOUR_MS = 5 * 60 * 60 * 1000
  var WEEK_MS = 7 * 24 * 60 * 60 * 1000

  function loadAccounts(ctx) {
    var res = ctx.host.cswap.list()
    if (res.status === "not_installed") throw INSTALL_HINT
    if (res.status !== "ok") throw "cswap failed: " + (res.message || "unknown error")
    var data = res.data || {}
    if (data.error) throw "cswap failed: " + (data.error.message || data.error.type)
    var accounts = Array.isArray(data.accounts) ? data.accounts : []
    if (accounts.length === 0) throw EMPTY_HINT
    return accounts
  }

  // Fresh usage first; cswap keeps the last good reading for stale rows.
  function usageOf(account) {
    return account.usage || account.lastGoodUsage || {}
  }

  function windowPct(win) {
    return win && typeof win.pct === "number" ? win.pct : null
  }

  function nameOf(account) {
    if (account.alias) return account.alias
    var email = String(account.email || "")
    return email.split("@")[0] || "#" + account.number
  }

  function flagOf(account, usage) {
    if (account.disabled) return "off"
    if (account.usageStatus === "token_expired") return "expired"
    var five = windowPct(usage.fiveHour)
    var week = windowPct(usage.sevenDay)
    if ((five !== null && five >= LIMIT_PCT) || (week !== null && week >= LIMIT_PCT)) return "limit"
    return null
  }

  // Some plans have no 7d window; leave the bar out instead of showing 0%.
  function bars(usage) {
    var out = []
    var wins = [["5h", usage.fiveHour], ["7d", usage.sevenDay]]
    for (var i = 0; i < wins.length; i++) {
      var win = wins[i][1]
      if (windowPct(win) === null) continue
      var b = { label: wins[i][0], used: win.pct }
      if (win.resetsAt) b.resetsAt = win.resetsAt
      out.push(b)
    }
    return out
  }

  function accountRow(account) {
    var usage = usageOf(account)
    var row = {
      id: String(account.number),
      name: nameOf(account),
      active: account.active === true,
      bars: bars(usage),
    }
    if (account.email) row.detail = account.email
    var flag = flagOf(account, usage)
    if (flag) row.flag = flag
    return row
  }

  function progress(ctx, label, win, periodMs) {
    var opts = { label: label, used: win.pct, limit: 100, format: { kind: "percent" }, periodDurationMs: periodMs }
    if (win && win.resetsAt) opts.resetsAt = win.resetsAt
    return ctx.line.progress(opts)
  }

  function probe(ctx) {
    var accounts = loadAccounts(ctx)
    accounts.sort(function (a, b) { return a.number - b.number })
    var rows = accounts.map(accountRow)
    var active = accounts.filter(function (a) { return a.active === true })[0]
    var ready = rows.filter(function (r) { return !r.active && !r.flag }).length

    var lines = []
    if (active) {
      var usage = usageOf(active)
      if (windowPct(usage.fiveHour) !== null) lines.push(progress(ctx, "Session", usage.fiveHour, FIVE_HOUR_MS))
      if (windowPct(usage.sevenDay) !== null) lines.push(progress(ctx, "Weekly", usage.sevenDay, WEEK_MS))
    }
    lines.push(ctx.line.text({
      label: "Ready",
      value: ready + " of " + (accounts.length - (active ? 1 : 0)) + " to switch to",
      subtitle: active ? "Active: " + nameOf(active) : "No active account",
    }))
    lines.push(ctx.line.accounts({ label: "Accounts", rows: rows }))

    return { plan: accounts.length + (accounts.length === 1 ? " account" : " accounts"), lines: lines }
  }

  globalThis.__openusage_plugin = { id: "claude-accounts", probe: probe }
})()
