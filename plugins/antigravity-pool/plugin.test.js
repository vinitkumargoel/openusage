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

function makeQuotaBody({ gemWeek = 0.6, gemFive = 0.9, rest = 1, weeklyReset = RESET_A }) {
  return {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-weekly", window: "weekly", resetTime: weeklyReset, remainingFraction: gemWeek },
          { bucketId: "gemini-5h", window: "5h", resetTime: RESET_5H, remainingFraction: gemFive },
        ],
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
    it("names the directory to create config.json in", () => {
      expect(() => plugin.probe(ctx)).toThrow(/\/tmp\/openusage-test\/plugin/)
    })

    it("rejects a config missing the management key", () => {
      writeConfig(ctx, { baseUrl: BASE_URL })
      expect(() => plugin.probe(ctx)).toThrow(/baseUrl and managementKey/)
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

  describe("staggered fan-out", () => {
    it("reads at most four accounts per probe", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: makePool() })
      plugin.probe(ctx)
      expect(apiCallCount(ctx)).toBe(4)
    })

    it("merges cached accounts so the pool fills in over successive probes", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: makePool() })

      expect(lineByLabel(plugin.probe(ctx), "Pool").subtitle).toBe("4 sampled")
      expect(lineByLabel(plugin.probe(ctx), "Pool").subtitle).toBe("8 sampled")
      expect(lineByLabel(plugin.probe(ctx), "Pool").subtitle).toBeUndefined()
      expect(apiCallCount(ctx)).toBe(9)
    })

    it("re-reads an account once it goes stale", () => {
      writeConfig(ctx)
      wireRelay(ctx, { files: [makeAccount({})] })
      plugin.probe(ctx)
      plugin.probe(ctx)
      expect(apiCallCount(ctx)).toBe(1)

      vi.setSystemTime(NOW_MS + 41 * 60 * 1000)
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
    const todayKey = () => {
      const d = new Date(NOW_MS)
      const m = d.getMonth() + 1
      const day = d.getDate()
      return `${d.getFullYear()}-${m < 10 ? "0" : ""}${m}-${day < 10 ? "0" : ""}${day}`
    }

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
