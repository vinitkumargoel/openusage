export type ProgressFormat =
  | { kind: "percent" }
  | { kind: "dollars" }
  | { kind: "count"; suffix: string }

/** `tokens` is optional; only plugins with token-level data (Claude, Codex) send it. */
export type HeatmapDay = { date: string; value: number; tokens?: number }

export type MetricLine =
  | { type: "text"; label: string; value: string; color?: string; subtitle?: string }
  | {
      type: "progress"
      label: string
      used: number
      limit: number
      format: ProgressFormat
      resetsAt?: string
      periodDurationMs?: number
      color?: string
    }
  | { type: "badge"; label: string; text: string; color?: string; subtitle?: string }
  | {
      type: "heatmap"
      label: string
      days: HeatmapDay[]
      format?: ProgressFormat | null
      color?: string
    }
  | {
      type: "histogram"
      label: string
      rows: HistogramRow[]
      columns?: HistogramColumns | null
      axis?: string | null
      color?: string
    }
  | { type: "accounts"; label: string; rows: AccountRow[]; color?: string }
  | { type: "pool"; label: string; pool: PoolData; color?: string }

/** A percent bar on an account row (5h, 7d). */
export type AccountBar = {
  label: string
  used: number
  resetsAt?: string
  /** Window length, to work out how much of it has passed. */
  periodMs?: number
  /** Percent an even spend would have used by now. */
  expected?: number
  /** Whether the current rate lasts to reset, and when it runs out. */
  lasts?: boolean
  emptyAt?: string
}

/** A quota window: percent left and when it refills. */
export type PoolWindow = { left: number; resetsAt?: string; periodMs?: number }

/** One account pooled behind a relay. */
export type PoolAccount = {
  id: string
  name: string
  state: "live" | "cooling" | "offline" | "sampling"
  /** "free" (no 5h bucket) or "model" (a model is parked). */
  tag?: string
  five?: PoolWindow
  week?: PoolWindow
  restFive?: PoolWindow
  restWeek?: PoolWindow
  /** Per recent bucket, on the pool's shared `slots`. */
  requests: number[]
  failures: number[]
  /** Lifetime counters. */
  ok: number
  failed: number
  cooldown?: { reason: string; until: string }
  models?: { model: string; until: string }[]
  project?: string
  joinedAt?: string
  refreshedAt?: string
  sampledAt?: string
}

export type PoolData = {
  five?: PoolWindow
  week?: PoolWindow
  restFive?: PoolWindow
  restWeek?: PoolWindow
  counts: { total: number; live: number; cooling: number; offline: number; sampled: number; unreachable: number }
  /** Percent. */
  errorRate?: number
  worstRate?: number
  cohorts: { count: number; left: number; resetsAt: string }[]
  slots: string[]
  axis?: string
  accounts: PoolAccount[]
}

/** A label/value pair shown in an account's detail sheet. */
export type AccountStat = { label: string; value: string }

/** One stored login. `id` is the slot the app passes to `switch_account`. */
export type AccountRow = {
  id: string
  name: string
  detail?: string
  active: boolean
  flag?: string
  bars: AccountBar[]
  stats?: AccountStat[]
}

/** One labelled row of small bars, with a value and a note on the right. */
export type HistogramRow = {
  label: string
  buckets: number[]
  value: string
  note: string
  color?: string
  tooltip?: string
}

export type HistogramColumns = { buckets: string; value: string; note: string }

export type ManifestLine = {
  type: "text" | "progress" | "badge" | "heatmap" | "histogram" | "accounts" | "pool"
  label: string
  scope: "overview" | "detail"
}

export type PluginLink = {
  label: string
  url: string
}

/** A field the Settings page renders for a plugin; saved to its config.json. */
export type PluginSettingField = {
  key: string
  label: string
  type: "text" | "url" | "secret"
  placeholder?: string | null
  help?: string | null
}

export type PluginOutput = {
  providerId: string
  displayName: string
  plan?: string
  lines: MetricLine[]
  iconUrl: string
}

export type PluginMeta = {
  id: string
  name: string
  iconUrl: string
  brandColor?: string
  lines: ManifestLine[]
  links?: PluginLink[]
  /** Ordered list of primary metric candidates. Frontend picks first available. */
  primaryCandidates: string[]
  settings?: PluginSettingField[]
  /** Card layout. "ledger" = tiles + limits table + usage strip + activity. */
  layout?: string | null
}

export type PluginDisplayState = {
  meta: PluginMeta
  data: PluginOutput | null
  loading: boolean
  error: string | null
  lastManualRefreshAt: number | null
  lastUpdatedAt: number | null
}
