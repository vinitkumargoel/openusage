import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

const NOW_ISO = "2026-09-01T07:12:39Z"
const NOW_MS = Date.parse(NOW_ISO)

// Cohort A: six accounts sharing one weekly reset ~10.5h out.
const RESET_A = "2026-09-01T17:44:31Z"
// Cohort B: three accounts 3.5 days later.
const RESET_B = "2026-09-05T08:37:57Z"
const RESET_5H = "2026-09-01T08:30:32Z"

const BASE_URL = "http://relay.test:8317"
const AUTH_FILES_URL = `${BASE_URL}/v0/management/auth-files`
const API_CALL_URL = `${BASE_URL}/v0/management/api-call`

// --- Fixtures ---

function makeAccount(overrides) {
  return Object.assign(
    {
      provider: "antigravity",
      auth_index: "idx1",
      project_id: "project-1",
      email: "pooled@example.com",
      status: "active",
      disabled: false,
      unavailable: false,
      success: 500,
      failed: 5,
    },
    overrides
  )
}

/** Nine antigravity accounts split across the two observed reset cohorts. */
function makePool() {
  const accounts = []
  for (let i = 0; i < 9; i += 1) {
    accounts.push(
      makeAccount({
        auth_index: `idx${i}`,
        project_id: `project-${i}`,
        success: 500 + i,
        failed: 5,
      })
    )
  }
  return accounts
}

/** Twenty 10-minute buckets in relay wall clock, last one current. */
function makeBuckets(counts = {}) {
  const out = []
  for (let i = 0; i < 20; i += 1) {
    const start = 17 * 60 + 20 + i * 10
    const end = start + 10
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
    out.push({ time: `${hhmm(start)}-${hhmm(end)}`, success: counts[i] ?? 0, failed: 0 })
  }
  return out
}

// `gemFive: null` drops the 5h bucket, which is what a free-tier account returns.
function makeQuotaBody({ gemWeek = 0.6, gemFive = 0.9, rest = 1, weeklyReset = RESET_A, fiveReset = RESET_5H }) {
  const gemini = [
    { bucketId: "gemini-weekly", window: "weekly", resetTime: weeklyReset, remainingFraction: gemWeek },
  ]
  if (gemFive !== null) {
    const bucket = { bucketId: "gemini-5h", window: "5h", remainingFraction: gemFive }
    if (fiveReset) bucket.resetTime = fiveReset
    gemini.push(bucket)
  }
  return {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: gemini,
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-weekly", window: "weekly", resetTime: RESET_B, remainingFraction: rest },
          { bucketId: "3p-5h", window: "5h", resetTime: RESET_5H, remainingFraction: rest },
        ],
      },
    ],
  }
}

/**
 * Wires the relay. `quotaFor` maps an authIndex to either quota options, or
 * `{ error: <upstream status> }` to fail that one account.
 */
function wireRelay(ctx, { files, quotaFor, authFiles }) {
  ctx.host.http.request = vi.fn((opts) => {
    if (opts.url === AUTH_FILES_URL) {
      if (authFiles) return authFiles
      return { status: 200, bodyText: JSON.stringify({ files }) }
    }
    if (opts.url === API_CALL_URL) {
      const sent = JSON.parse(opts.bodyText)
      const spec = quotaFor ? quotaFor(sent.authIndex) : {}
      if (spec && spec.error) {
        return { status: 200, bodyText: JSON.stringify({ status_code: spec.error, body: "{}" }) }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          status_code: 200,
          body: JSON.stringify(makeQuotaBody(spec || {})),
        }),
      }
    }
    throw new Error(`unexpected url ${opts.url}`)
  })
}

function writeConfig(ctx, config = { baseUrl: BASE_URL, managementKey: "secret-key" }) {
  ctx.host.fs.writeText(`${ctx.app.pluginDataDir}/config.json`, JSON.stringify(config))
}

// The plugin keys days in local time, so tests must too.
const dayKeyOf = (ms) => {
  const d = new Date(ms)
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${d.getFullYear()}-${m < 10 ? "0" : ""}${m}-${day < 10 ? "0" : ""}${day}`
}
const todayKey = () => dayKeyOf(NOW_MS)

const lineByLabel = (result, label) => result.lines.find((line) => line.label === label)
const apiCallCount = (ctx) =>
  ctx.host.http.request.mock.calls.filter(([opts]) => opts.url === API_CALL_URL).length

describe("antigravity-pool plugin", () => {
  let ctx
  let plugin

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    ctx = makeCtx()
    plugin = await loadPlugin()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("config", () => {
    it("points at Settings when there is no config yet", () => {
      expect(() => plugin.probe(ctx)).toThrow(/Settings → Plugin Settings/)
    })

    it("rejects a relay url without a scheme", () => {
      writeConfig(ctx, { baseUrl: "100.105.72.106:8317", managementKey: "secret-key" })
      expect(() => plugin.probe(ctx)).toThrow(/must start with http/)
    })

    it("rejects a config missing the management key", () => {
      writeConfig(ctx, { baseUrl: BASE_URL })
      expect(() => plugin.probe(ctx)).toThrow(/Settings → Plugin Settings/)
    })

    it("falls through to the next relay address when one is unreachable, and remembers it", () => {
      writeConfig(ctx, { baseUrl: "http://100.64.0.1:8317, http://relay.test:8317/", managementKey: "secret-key" })
      const relay = ctx.host.http.request
      wireRelay(ctx, { files: [makeAccount({})] })
      const wired = ctx.host.http.request
      ctx.host.http.request = vi.fn((opts) => {
        if (opts.url.startsWith("http://100.64.0.1:8317")) throw new Error("timeout")
        return wired(opts)
      })
      expect(lineByLabel(plugin.probe(ctx), "Pool").value).toBe("1 account")
      const urls = ctx.host.http.request.mock.calls.map(([opts]) => opts.url)
      expect(urls[0]).toBe("http://100.64.0.1:8317/v0/management/auth-files")
      expect(urls[1]).toBe(AUTH_FILES_URL)
      expect(urls.filter((url) => url === API_CALL_URL)).toHaveLength(1)

      // Next probe goes straight to the address that answered.
      ctx.host.http.request.mockClear()
      vi.setSystemTime(NOW_MS + 5 * 60 * 1000)
      plugin.probe(ctx)
      expect(ctx.host.http.request.mock.calls[0][0].url).toBe(AUTH_FILES_URL)
      void relay
    })

    it("names every address when none answers", () => {
      writeConfig(ctx, { baseUrl: "http://a:1 http://b:2", managementKey: "secret-key" })
      ctx.host.http.request = vi.fn(() => {
        throw new Error("connection refused")
      })
      expect(() => plugin.probe(ctx)).toThrow("Cannot reach CLIProxy at http://a:1, http://b:2")
    })

    it("does not fall through on an HTTP error, which is the relay answering", () => {
      writeConfig(ctx, { baseUrl: `${BASE_URL}, http://second:8317`, managementKey: "secret-key" })
      wireRelay(ctx, { files: [], authFiles: { status: 401, bodyText: JSON.stringify({ error: "invalid management key" }) } })
      expect(() => plugin.probe(ctx)).toThrow(/CLIProxy 401: invalid management key/)
      expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    })

    it("strips a trailing /v1 from the base url", () => {
      writeConfig(ctx, { baseUrl: `${BASE_URL}/v1/`, managementKey: "secret-key" })
      wireRelay(ctx, { files: [makeAccount({})] })
      plugin.probe(ctx)
      expect(ctx.host.http.request.mock.calls[0][0].url).toBe(AUTH_FILES_URL)
    })

    it("sends the management key as a header, never in the url", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({})] })
      plugin.probe(ctx)
      for (const [opts] of ctx.host.http.request.mock.calls) {
        expect(opts.url).not.toContain("secret-key")
        expect(opts.headers["X-Management-Key"]).toBe("secret-key")
      }
    })
  })

  describe("relay failures", () => {
    it("surfaces the relay's own error text", () => {
      writeConfig(ctx)
      wireRelay(ctx, {
        files: [],
        authFiles: {
          status: 403,
          bodyText: JSON.stringify({ error: "IP banned due to too many failed attempts. Try again in 22m19s" }),
        },
      })
      expect(() => plugin.probe(ctx)).toThrow(/CLIProxy 403: IP banned/)
    })

    it("reports an unreachable relay", () => {
      writeConfig(ctx)
      ctx.host.http.request = vi.fn(() => {
        throw new Error("connection refused")
      })
      expect(() => plugin.probe(ctx)).toThrow(/Cannot reach CLIProxy/)
    })

    it("reports an empty pool", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({ provider: "claude" })] })
      expect(() => plugin.probe(ctx)).toThrow(/No Antigravity accounts/)
    })

    it("carries the last upstream error when every account fails", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({})], quotaFor: () => ({ error: 429 }) })
      expect(() => plugin.probe(ctx)).toThrow(/No quota returned \(quota API 429\)/)
    })
  })

  describe("aggregation", () => {
    it("shows the pool mean, not any one account", () => {
      writeConfig(ctx)
      const files = [makeAccount({ auth_index: "a" }), makeAccount({ auth_index: "b" })]
      wireRelay(ctx, {
        files,
        quotaFor: (idx) => (idx === "a" ? { gemWeek: 0.6, gemFive: 0.9 } : { gemWeek: 0.9, gemFive: 0.7 }),
      })
      const result = plugin.probe(ctx)
      // mean 0.75 left -> 25 used; mean 0.8 left -> 20 used
      expect(lineByLabel(result, "Gemini weekly").used).toBe(25)
      expect(lineByLabel(result, "Gemini 5h").used).toBe(20)
      expect(lineByLabel(result, "Pool").value).toBe("2 accounts")
    })

    it("labels the card as coming from the relay", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({})] })
      expect(plugin.probe(ctx).plan).toBe("CLIProxy")
    })

    it("counts down to the earliest reset in the pool", () => {
      writeConfig(ctx)
      const files = [makeAccount({ auth_index: "a" }), makeAccount({ auth_index: "b" })]
      wireRelay(ctx, {
        files,
        quotaFor: (idx) => (idx === "a" ? { weeklyReset: RESET_B } : { weeklyReset: RESET_A }),
      })
      const weekly = lineByLabel(plugin.probe(ctx), "Gemini weekly")
      expect(weekly.resetsAt).toBe(RESET_A)
      expect(weekly.periodDurationMs).toBe(7 * 24 * 60 * 60 * 1000)
    })

    it("collapses Claude & GPT to one line", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({})], quotaFor: () => ({ rest: 1 }) })
      const result = plugin.probe(ctx)
      expect(lineByLabel(result, "Claude & GPT").value).toBe("100% left")
      expect(result.lines.filter((line) => line.label === "Claude & GPT")).toHaveLength(1)
    })

    it("leaves offline accounts out of the mean but visible in the count", () => {
      writeConfig(ctx)
      const files = [
        makeAccount({ auth_index: "a" }),
        makeAccount({ auth_index: "b", disabled: true }),
      ]
      wireRelay(ctx, { files, quotaFor: () => ({ gemWeek: 0.6 }) })
      const result = plugin.probe(ctx)
      expect(apiCallCount(ctx)).toBe(1)
      expect(lineByLabel(result, "Gemini weekly").used).toBe(40)
      expect(lineByLabel(result, "Pool").value).toBe("2 accounts")
      expect(lineByLabel(result, "Pool").subtitle).toBe("1 offline")
    })
  })

  describe("reset cohorts", () => {
    it("groups accounts that reset on the same hour", () => {
      writeConfig(ctx)
      const files = makePool()
      wireRelay(ctx, {
        files,
        quotaFor: (idx) =>
          Number(idx.slice(3)) < 6
            ? { gemWeek: 0.6, weeklyReset: RESET_A }
            : { gemWeek: 0.9, weeklyReset: RESET_B },
      })
      // Three probes to sample all nine accounts through the stagger.
      plugin.probe(ctx)
      plugin.probe(ctx)
      const result = plugin.probe(ctx)

      const cohorts = result.lines.filter((line) => /^\d+ accounts?$/.test(line.label))
      expect(cohorts).toHaveLength(2)
      expect(cohorts[0]).toMatchObject({ label: "6 accounts", value: "60% left · 10h 31m" })
      expect(cohorts[1]).toMatchObject({ label: "3 accounts", value: "90% left · 4d 1h" })
    })

    it("stays quiet when every window is aligned", () => {
      writeConfig(ctx)
      const files = [makeAccount({ auth_index: "a" }), makeAccount({ auth_index: "b" })]
      wireRelay(ctx, { files, quotaFor: () => ({ weeklyReset: RESET_A }) })
      const result = plugin.probe(ctx)
      expect(result.lines.filter((line) => /^\d+ accounts?$/.test(line.label))).toHaveLength(0)
    })

    it("treats resets either side of the half hour as one cohort", () => {
      // Twenty seconds apart, but they round to different hours.
      writeConfig(ctx)
      const files = [makeAccount({ auth_index: "a" }), makeAccount({ auth_index: "b" })]
      wireRelay(ctx, {
        files,
        quotaFor: (idx) =>
          idx === "a" ? { weeklyReset: "2026-09-01T17:29:50Z" } : { weeklyReset: "2026-09-01T17:30:10Z" },
      })
      const result = plugin.probe(ctx)
      expect(result.lines.filter((line) => /^\d+ accounts?$/.test(line.label))).toHaveLength(0)
    })

    it("treats resets minutes apart as one cohort", () => {
      writeConfig(ctx)
      const files = [makeAccount({ auth_index: "a" }), makeAccount({ auth_index: "b" })]
      wireRelay(ctx, {
        files,
        quotaFor: (idx) =>
          idx === "a" ? { weeklyReset: "2026-09-01T17:44:31Z" } : { weeklyReset: "2026-09-01T17:45:12Z" },
      })
      const result = plugin.probe(ctx)
      expect(result.lines.filter((line) => /^\d+ accounts?$/.test(line.label))).toHaveLength(0)
    })
  })

  describe("weekly countdown", () => {
    it("ignores a cached reset that has already passed", () => {
      writeConfig(ctx)
      const files = [makeAccount({ auth_index: "a" }), makeAccount({ auth_index: "b" })]
      wireRelay(ctx, {
        files,
        quotaFor: (idx) =>
          idx === "a" ? { weeklyReset: RESET_B } : { weeklyReset: "2026-09-01T09:00:00Z" },
      })
      plugin.probe(ctx)

      // Past b's reset, and b's relay call now fails — so its stale reading,
      // whose reset instant is gone, is all that is left on disk for it.
      vi.setSystemTime(Date.parse("2026-09-01T12:00:00Z"))
      const wired = ctx.host.http.request
      ctx.host.http.request = vi.fn((opts) => {
        if (opts.url === API_CALL_URL && JSON.parse(opts.bodyText).authIndex === "b") {
          throw new Error("connection refused")
        }
        return wired(opts)
      })
      const weekly = lineByLabel(plugin.probe(ctx), "Gemini weekly")
      expect(weekly.resetsAt).toBe(RESET_B)
    })

    it("drops the countdown when every cached reset is in the past", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({ auth_index: "a" })], quotaFor: () => ({ weeklyReset: RESET_A }) })
      plugin.probe(ctx)

      vi.setSystemTime(Date.parse("2026-09-09T07:12:39Z"))
      const wired = ctx.host.http.request
      ctx.host.http.request = vi.fn((opts) => {
        if (opts.url === API_CALL_URL) throw new Error("connection refused")
        return wired(opts)
      })
      expect(lineByLabel(plugin.probe(ctx), "Gemini weekly").resetsAt).toBeUndefined()
    })
  })

  describe("fan-out", () => {
    it("reads the whole pool in one probe", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: makePool() })
      const result = plugin.probe(ctx)
      expect(apiCallCount(ctx)).toBe(9)
      expect(lineByLabel(result, "Pool").subtitle).toBeUndefined()
    })

    it("stops at the time budget and fills the rest in on the next probe", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: makePool() })
      // Every quota call costs 3s of wall clock: the 16s budget admits six.
      const relay = ctx.host.http.request
      ctx.host.http.request = vi.fn((opts) => {
        if (opts.url === API_CALL_URL) vi.setSystemTime(Date.now() + 3000)
        return relay(opts)
      })

      expect(lineByLabel(plugin.probe(ctx), "Pool").subtitle).toBe("6 sampled")
      expect(lineByLabel(plugin.probe(ctx), "Pool").subtitle).toBeUndefined()
      expect(apiCallCount(ctx)).toBe(9)
    })

    it("re-reads an account once it goes stale", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({})] })
      plugin.probe(ctx)
      vi.setSystemTime(NOW_MS + 3 * 60 * 1000)
      plugin.probe(ctx)
      expect(apiCallCount(ctx)).toBe(1)

      vi.setSystemTime(NOW_MS + 5 * 60 * 1000)
      plugin.probe(ctx)
      expect(apiCallCount(ctx)).toBe(2)
    })

    it("drops accounts that left the pool", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({ auth_index: "a" }), makeAccount({ auth_index: "b" })] })
      plugin.probe(ctx)

      wireRelay(ctx, { files: [makeAccount({ auth_index: "a" })] })
      const result = plugin.probe(ctx)
      expect(lineByLabel(result, "Pool").value).toBe("1 account")

      const state = JSON.parse(ctx.host.fs.readText(`${ctx.app.pluginDataDir}/pool-state.json`))
      expect(Object.keys(state.accounts)).toEqual(["a"])
    })

    it("counts an unreachable account without dropping the rest", () => {
      writeConfig(ctx)
      const files = [makeAccount({ auth_index: "a" }), makeAccount({ auth_index: "b" })]
      wireRelay(ctx, { files, quotaFor: (idx) => (idx === "b" ? { error: 500 } : { gemWeek: 0.6 }) })
      const result = plugin.probe(ctx)
      expect(lineByLabel(result, "Gemini weekly").used).toBe(40)
      expect(lineByLabel(result, "Pool").subtitle).toBe("1 unreachable")
    })
  })

  describe("request history", () => {
    it("records nothing on the first sight of an account", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({ success: 500 })] })
      const result = plugin.probe(ctx)
      expect(lineByLabel(result, "Requests")).toBeUndefined()
    })

    it("accumulates the increment between probes", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({ auth_index: "a", success: 500 })] })
      plugin.probe(ctx)

      wireRelay(ctx, { files: [makeAccount({ auth_index: "a", success: 512 })] })
      wireRelay(ctx, { files: [makeAccount({ auth_index: "a", success: 520 })] })
      plugin.probe(ctx)

      const heatmap = lineByLabel(plugin.probe(ctx), "Requests")
      expect(heatmap.type).toBe("heatmap")
      expect(heatmap.format).toEqual({ kind: "count", suffix: "req" })
      expect(heatmap.days).toEqual([{ date: todayKey(), value: 20 }])
    })

    it("does not spike when an account joins the pool", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({ auth_index: "a", success: 100 })] })
      plugin.probe(ctx)

      wireRelay(ctx, {
        files: [
          makeAccount({ auth_index: "a", success: 110 }),
          makeAccount({ auth_index: "b", success: 9000 }),
        ],
      })
      const heatmap = lineByLabel(plugin.probe(ctx), "Requests")
      expect(heatmap.days).toEqual([{ date: todayKey(), value: 10 }])
    })

    it("treats a counter reset as the relay restarting", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({ auth_index: "a", success: 900 })] })
      plugin.probe(ctx)

      wireRelay(ctx, { files: [makeAccount({ auth_index: "a", success: 7 })] })
      const heatmap = lineByLabel(plugin.probe(ctx), "Requests")
      expect(heatmap.days).toEqual([{ date: todayKey(), value: 7 }])
    })

    it("keeps recording while the quota API is down", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({ auth_index: "a", success: 100 })], quotaFor: () => ({ error: 503 }) })
      expect(() => plugin.probe(ctx)).toThrow(/No quota returned/)

      wireRelay(ctx, { files: [makeAccount({ auth_index: "a", success: 130 })], quotaFor: () => ({ error: 503 }) })
      expect(() => plugin.probe(ctx)).toThrow(/No quota returned/)

      const state = JSON.parse(ctx.host.fs.readText(`${ctx.app.pluginDataDir}/pool-state.json`))
      expect(state.days[todayKey()]).toBe(30)
    })

    it("keeps showing a cached account when its refresh fails", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({ auth_index: "a" })], quotaFor: () => ({ gemWeek: 0.6 }) })
      plugin.probe(ctx)

      vi.setSystemTime(NOW_MS + 41 * 60 * 1000)
      wireRelay(ctx, { files: [makeAccount({ auth_index: "a" })], quotaFor: () => ({ error: 503 }) })
      const result = plugin.probe(ctx)
      expect(lineByLabel(result, "Gemini weekly").used).toBe(40)
      expect(lineByLabel(result, "Pool").subtitle).toBe("1 unreachable")
    })
  })

  describe("per-account rows", () => {
    const rowsOf = (result) => lineByLabel(result, "Accounts · 5h").rows

    it("draws one row per account from the relay's request buckets, driest first", () => {
      writeConfig(ctx)
      const files = [
        makeAccount({ auth_index: "a", project_id: "alien-agency-s1ttq", recent_requests: makeBuckets({ 5: 31, 6: 3, 17: 23 }) }),
        makeAccount({ auth_index: "b", project_id: "yodeling-myth-g620j", recent_requests: makeBuckets({ 17: 8 }) }),
      ]
      wireRelay(ctx, { files, quotaFor: (idx) => (idx === "a" ? { gemFive: 0.93, gemWeek: 0.91 } : { gemFive: 0.65, gemWeek: 0.56 }) })
      const line = lineByLabel(plugin.probe(ctx), "Accounts · 5h")

      expect(line.type).toBe("histogram")
      expect(line.columns).toEqual({ buckets: "requests", value: "5h left", note: "resets" })
      expect(line.axis).toBe("17:20 → 20:40 relay time · 10-min buckets")
      expect(line.rows.map((row) => row.label)).toEqual(["yodeling-myth", "alien-agency"])

      const [driest, freshest] = line.rows
      expect(driest).toMatchObject({ value: "65%", note: "1h 17m" })
      expect(driest.buckets).toHaveLength(20)
      expect(driest.buckets[17]).toBe(8)
      expect(driest.tooltip).toBe("56% weekly left · resets in 10h 31m · 8 requests in the last 200m")
      expect(driest.color).toBeUndefined()
      expect(freshest.buckets[5]).toBe(31)
      expect(freshest.tooltip).toContain("57 requests")
    })

    it("names accounts by project words, or by alias when configured", () => {
      writeConfig(ctx, { baseUrl: BASE_URL, managementKey: "secret-key", aliases: { b: "work-2" } })
      const files = [
        makeAccount({ auth_index: "a", project_id: "alien-agency-s1ttq" }),
        makeAccount({ auth_index: "b", project_id: "still-bond-8ds98" }),
        makeAccount({ auth_index: "c123456", project_id: "" }),
      ]
      wireRelay(ctx, { files })
      const labels = rowsOf(plugin.probe(ctx)).map((row) => row.label)
      expect(labels).toEqual(expect.arrayContaining(["alien-agency", "work-2", "#c12345"]))
    })

    it("colours a nearly drained window", () => {
      writeConfig(ctx)
      const files = [makeAccount({ auth_index: "a" }), makeAccount({ auth_index: "b" }), makeAccount({ auth_index: "c" })]
      wireRelay(ctx, { files, quotaFor: (idx) => ({ gemFive: idx === "a" ? 0.05 : idx === "b" ? 0.2 : 0.5 }) })
      const rows = rowsOf(plugin.probe(ctx))
      expect(rows.map((row) => [row.value, row.color])).toEqual([
        ["5%", "#ef4444"],
        ["20%", "#f59e0b"],
        ["50%", undefined],
      ])
    })

    it("shows a relay cooldown in red and keeps that account out of the pool mean", () => {
      writeConfig(ctx)
      const retryAt = new Date(NOW_MS + 41 * 60 * 1000).toISOString()
      const files = [
        makeAccount({ auth_index: "a", cooldowns: [{ scope: "credential", reason: "credential_quota", retry_at: retryAt }] }),
        makeAccount({ auth_index: "b" }),
      ]
      wireRelay(ctx, { files, quotaFor: (idx) => ({ gemWeek: idx === "a" ? 0.1 : 0.7 }) })
      const result = plugin.probe(ctx)
      const [cooling] = rowsOf(result)
      expect(cooling).toMatchObject({ value: "cooling", note: "41m", color: "#ef4444" })
      expect(cooling.tooltip).toContain("relay credential_quota · retries in 41m")
      expect(lineByLabel(result, "Gemini weekly").used).toBe(30)
      expect(lineByLabel(result, "Pool").subtitle).toBe("1 cooling")
    })

    it("ignores a cooldown that has already expired", () => {
      writeConfig(ctx)
      const retryAt = new Date(NOW_MS - 1000).toISOString()
      wireRelay(ctx, { files: [makeAccount({ cooldowns: [{ reason: "quota", retry_at: retryAt }] })] })
      const [row] = rowsOf(plugin.probe(ctx))
      expect(row.value).toBe("90%")
      expect(row.color).toBeUndefined()
    })

    it("handles a free-tier account with no 5h bucket, an idle window, and an offline account", () => {
      writeConfig(ctx)
      const files = [
        makeAccount({ auth_index: "free" }),
        makeAccount({ auth_index: "idle" }),
        makeAccount({ auth_index: "off", disabled: true }),
      ]
      wireRelay(ctx, {
        files,
        quotaFor: (idx) => (idx === "free" ? { gemFive: null, gemWeek: 0.38 } : { gemFive: 1, fiveReset: null }),
      })
      const rows = rowsOf(plugin.probe(ctx))
      expect(rows.map((row) => row.label)).toEqual(["project-1", "project-1", "project-1"])
      const free = rows.find((row) => row.value === "wk only")
      expect(free.note).toBe("wk 10h 31m")
      expect(free.tooltip).toContain("no 5h bucket (free tier)")
      const idle = rows.find((row) => row.value === "100%")
      expect(idle.note).toBe("idle")
      expect(rows[2]).toMatchObject({ value: "offline", note: "—", color: "#ef4444" })
    })

    it("marks an account the probe has not sampled yet", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({ auth_index: "a" }), makeAccount({ auth_index: "b" })], quotaFor: (idx) => (idx === "b" ? { error: 500 } : {}) })
      const rows = rowsOf(plugin.probe(ctx))
      expect(rows[1]).toMatchObject({ value: "—", note: "sampling" })
    })

    it("says so when the relay sends no request history", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({})] })
      const line = lineByLabel(plugin.probe(ctx), "Accounts · 5h")
      expect(line.axis).toBe("no request history from the relay")
      expect(line.rows[0].buckets).toEqual([])
    })
  })

  describe("retention", () => {
    it("keeps at most 400 day keys, so today is never the one the host drops", () => {
      writeConfig(ctx)
      const days = {}
      for (let back = 0; back < 405; back += 1) {
        days[dayKeyOf(NOW_MS - back * 24 * 60 * 60 * 1000)] = 1
      }
      ctx.host.fs.writeText(
        `${ctx.app.pluginDataDir}/pool-state.json`,
        JSON.stringify({ accounts: {}, counters: {}, days })
      )
      wireRelay(ctx, { files: [makeAccount({ auth_index: "a", success: 10 })] })
      plugin.probe(ctx)
      const stored = JSON.parse(ctx.host.fs.readText(`${ctx.app.pluginDataDir}/pool-state.json`))
      const keys = Object.keys(stored.days).sort()
      expect(keys.length).toBeLessThanOrEqual(400)
      expect(keys[keys.length - 1]).toBe(todayKey())
    })
  })

  describe("histogram grid", () => {
    it("draws every row on one time grid, zero-filling a shorter series", () => {
      writeConfig(ctx)
      const full = makeBuckets({ 0: 3, 19: 4 })
      wireRelay(ctx, {
        files: [
          makeAccount({ auth_index: "a", recent_requests: full }),
          // Only the last three buckets of the same grid.
          makeAccount({ auth_index: "b", recent_requests: full.slice(17).map((b) => ({ ...b, success: 2 })) }),
        ],
      })
      const line = lineByLabel(plugin.probe(ctx), "Accounts · 5h")
      const lengths = line.rows.map((row) => row.buckets.length)
      expect(lengths).toEqual([20, 20])
      const short = line.rows.find((row) => row.buckets[0] === 0 && row.buckets[19] === 2)
      expect(short.buckets.slice(0, 17)).toEqual(new Array(17).fill(0))
      // The axis is the grid, not the first row stitched to the last.
      expect(line.axis).toBe("17:20 → 20:40 relay time · 10-min buckets")
    })
  })

  describe("redaction", () => {
    it("never stores or renders an account email", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: makePool() })
      const result = plugin.probe(ctx)
      expect(JSON.stringify(result)).not.toContain("pooled@example.com")
      const stored = ctx.host.fs.readText(`${ctx.app.pluginDataDir}/pool-state.json`)
      expect(stored).not.toContain("pooled@example.com")
    })

    it("never writes the management key into the pool state", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({})] })
      plugin.probe(ctx)
      const stored = ctx.host.fs.readText(`${ctx.app.pluginDataDir}/pool-state.json`)
      expect(stored).not.toContain("secret-key")
    })
  })

  describe("malformed relay data", () => {
    it("does not claim a window refills now when the reset is unparseable", () => {
      writeConfig(ctx)
      wireRelay(ctx, {
        files: [makeAccount({ auth_index: "a" })],
        quotaFor: () => ({ weeklyReset: "soon", fiveReset: "later" }),
      })
      const rows = lineByLabel(plugin.probe(ctx), "Accounts · 5h").rows
      expect(rows[0].note).toBe("idle")
      expect(rows[0].tooltip ?? "").not.toContain("resets in now")
    })

    it("says so loudly when the stored state is corrupt", () => {
      writeConfig(ctx)
      ctx.host.fs.writeText(`${ctx.app.pluginDataDir}/pool-state.json`, '{"days":{"2026-08-')
      wireRelay(ctx, { files: [makeAccount({})] })
      plugin.probe(ctx)
      expect(ctx.host.log.error).toHaveBeenCalledWith(expect.stringContaining("pool-state.json"))
    })
  })

  describe("rotation health", () => {
    it("reports the pool error rate", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({ success: 990, failed: 10 })] })
      expect(lineByLabel(plugin.probe(ctx), "Rotation").value).toBe("1.0% errors")
    })

    it("names an account failing well above the pool rate", () => {
      writeConfig(ctx)
      const files = [
        makeAccount({ auth_index: "a", success: 1000, failed: 5 }),
        makeAccount({ auth_index: "b", success: 1000, failed: 5 }),
        makeAccount({ auth_index: "c", success: 547, failed: 19 }),
      ]
      wireRelay(ctx, { files })
      const rotation = lineByLabel(plugin.probe(ctx), "Rotation")
      expect(rotation.subtitle).toBe("worst account 3.4%")
      expect(rotation.color).toBeUndefined()
    })

    it("flags an offline account in red", () => {
      writeConfig(ctx)
      const files = [
        makeAccount({ auth_index: "a" }),
        makeAccount({ auth_index: "b", unavailable: true }),
      ]
      wireRelay(ctx, { files })
      const rotation = lineByLabel(plugin.probe(ctx), "Rotation")
      expect(rotation.subtitle).toBe("1 account offline")
      expect(rotation.color).toBe("#ef4444")
    })
  })

  describe("overview contract", () => {
    it("emits every label the manifest declares for the overview", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({})] })
      const labels = plugin.probe(ctx).lines.map((line) => line.label)
      expect(labels).toEqual(expect.arrayContaining(["Gemini weekly", "Gemini 5h", "Pool"]))
    })
  })
})
