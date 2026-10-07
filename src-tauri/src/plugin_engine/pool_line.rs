//! The `pool` line: accounts pooled behind a relay, one tile each, plus the
//! pool-wide summary the detail page leads with. Display only — no actions,
//! so it is shape-checked and capped, nothing more.

use rquickjs::{Ctx, Object, Value};
use serde::{Deserialize, Serialize};

const MAX_ACCOUNTS: usize = 50;
const MAX_BUCKETS: usize = 30;
const MAX_COHORTS: usize = 8;
const MAX_MODELS: usize = 8;
const MAX_TEXT: usize = 120;
const STATES: [&str; 4] = ["live", "cooling", "offline", "sampling"];

/// One quota window: percent left and when it refills.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PoolWindow {
    pub left: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PoolCohort {
    pub count: u32,
    pub left: f64,
    pub resets_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PoolCounts {
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub live: u32,
    #[serde(default)]
    pub cooling: u32,
    #[serde(default)]
    pub offline: u32,
    #[serde(default)]
    pub sampled: u32,
    #[serde(default)]
    pub unreachable: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PoolCooldown {
    pub reason: String,
    pub until: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PoolModelCooldown {
    pub model: String,
    pub until: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PoolAccount {
    pub id: String,
    pub name: String,
    /// live | cooling | offline | sampling
    pub state: String,
    /// Short extra tag, e.g. "free" (no 5h bucket) or "model" (a model parked).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five: Option<PoolWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week: Option<PoolWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rest_five: Option<PoolWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rest_week: Option<PoolWindow>,
    /// Successful and failed requests per recent bucket, on the pool's slots.
    #[serde(default)]
    pub requests: Vec<f64>,
    #[serde(default)]
    pub failures: Vec<f64>,
    /// Lifetime counters from the relay.
    #[serde(default)]
    pub ok: f64,
    #[serde(default)]
    pub failed: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooldown: Option<PoolCooldown>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<PoolModelCooldown>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub joined_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refreshed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampled_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PoolData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five: Option<PoolWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week: Option<PoolWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rest_five: Option<PoolWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rest_week: Option<PoolWindow>,
    #[serde(default)]
    pub counts: PoolCounts,
    /// Pool-wide and worst single-account error rates, in percent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worst_rate: Option<f64>,
    #[serde(default)]
    pub cohorts: Vec<PoolCohort>,
    /// Bucket labels ("HH:MM-HH:MM", relay time) shared by every account.
    #[serde(default)]
    pub slots: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub axis: Option<String>,
    #[serde(default)]
    pub accounts: Vec<PoolAccount>,
}

fn clip(s: &mut String) {
    if s.chars().count() > MAX_TEXT {
        *s = s.chars().take(MAX_TEXT).collect();
    }
}

fn clip_opt(s: &mut Option<String>) {
    if let Some(s) = s {
        clip(s);
    }
}

fn percent(value: f64, what: &str, idx: usize) -> Result<f64, String> {
    if !value.is_finite() {
        return Err(format!("pool line at index {idx}: {what} must be a number"));
    }
    Ok(value.clamp(0.0, 100.0))
}

fn check_window(win: &mut Option<PoolWindow>, what: &str, idx: usize) -> Result<(), String> {
    if let Some(w) = win {
        w.left = percent(w.left, what, idx)?;
        w.period_ms = w.period_ms.filter(|p| p.is_finite() && *p > 0.0);
        clip_opt(&mut w.resets_at);
    }
    Ok(())
}

fn counts(values: &mut Vec<f64>) {
    values.truncate(MAX_BUCKETS);
    for v in values.iter_mut() {
        *v = if v.is_finite() { v.max(0.0) } else { 0.0 };
    }
}

pub(crate) fn parse_pool_json(json: &str, idx: usize) -> Result<PoolData, String> {
    let mut pool: PoolData =
        serde_json::from_str(json).map_err(|e| format!("pool line at index {idx}: invalid data: {e}"))?;
    check_window(&mut pool.five, "five.left", idx)?;
    check_window(&mut pool.week, "week.left", idx)?;
    check_window(&mut pool.rest_five, "restFive.left", idx)?;
    check_window(&mut pool.rest_week, "restWeek.left", idx)?;
    pool.error_rate = pool.error_rate.filter(|r| r.is_finite()).map(|r| r.clamp(0.0, 100.0));
    pool.worst_rate = pool.worst_rate.filter(|r| r.is_finite()).map(|r| r.clamp(0.0, 100.0));
    pool.cohorts.truncate(MAX_COHORTS);
    for c in &mut pool.cohorts {
        c.left = percent(c.left, "cohort left", idx)?;
        clip(&mut c.resets_at);
    }
    pool.slots.truncate(MAX_BUCKETS);
    for s in &mut pool.slots {
        clip(s);
    }
    clip_opt(&mut pool.axis);
    pool.accounts.truncate(MAX_ACCOUNTS);
    for a in &mut pool.accounts {
        if !STATES.contains(&a.state.as_str()) {
            return Err(format!("pool line at index {idx}: unknown account state '{}'", a.state));
        }
        clip(&mut a.id);
        clip(&mut a.name);
        clip_opt(&mut a.tag);
        check_window(&mut a.five, "account five.left", idx)?;
        check_window(&mut a.week, "account week.left", idx)?;
        check_window(&mut a.rest_five, "account restFive.left", idx)?;
        check_window(&mut a.rest_week, "account restWeek.left", idx)?;
        counts(&mut a.requests);
        counts(&mut a.failures);
        a.ok = if a.ok.is_finite() { a.ok.max(0.0) } else { 0.0 };
        a.failed = if a.failed.is_finite() { a.failed.max(0.0) } else { 0.0 };
        if let Some(c) = &mut a.cooldown {
            clip(&mut c.reason);
            clip(&mut c.until);
        }
        a.models.truncate(MAX_MODELS);
        for m in &mut a.models {
            clip(&mut m.model);
            clip(&mut m.until);
        }
        for s in [&mut a.email, &mut a.project, &mut a.joined_at, &mut a.refreshed_at, &mut a.sampled_at] {
            clip_opt(s);
        }
    }
    Ok(pool)
}

pub(crate) fn parse_pool<'js>(ctx: &Ctx<'js>, line: &Object<'js>, idx: usize) -> Result<PoolData, String> {
    let pool: Value<'js> = line
        .get("pool")
        .map_err(|_| format!("pool line at index {idx} missing pool object"))?;
    if !pool.is_object() {
        return Err(format!("pool line at index {idx} missing pool object"));
    }
    let json = ctx
        .json_stringify(pool)
        .ok()
        .flatten()
        .and_then(|s| s.to_string().ok())
        .ok_or_else(|| format!("pool line at index {idx}: pool not serializable"))?;
    parse_pool_json(&json, idx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_clamps() {
        let pool = parse_pool_json(
            r#"{"five":{"left":140,"resetsAt":"2026-10-07T20:00:00Z","periodMs":18000000},
                "counts":{"total":2,"live":1,"offline":1},"errorRate":2.1,
                "cohorts":[{"count":2,"left":30,"resetsAt":"2026-10-09T00:00:00Z"}],
                "slots":["20:40-20:50"],
                "accounts":[{"id":"abc","name":"carbon-creek","state":"live",
                  "five":{"left":-5},"requests":[3,-1],"failures":[1],"ok":10,"failed":1}]}"#,
            0,
        )
        .unwrap();
        assert_eq!(pool.five.as_ref().unwrap().left, 100.0);
        assert_eq!(pool.counts.offline, 1);
        let a = &pool.accounts[0];
        assert_eq!(a.five.as_ref().unwrap().left, 0.0);
        assert_eq!(a.requests, vec![3.0, 0.0]);
    }

    #[test]
    fn rejects_unknown_state() {
        let err = parse_pool_json(r#"{"accounts":[{"id":"a","name":"x","state":"zombie"}]}"#, 4).unwrap_err();
        assert!(err.contains("zombie"));
    }

    #[test]
    fn caps_sizes() {
        let acct = r#"{"id":"a","name":"x","state":"live","requests":[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]}"#;
        let json = format!(r#"{{"accounts":[{}]}}"#, vec![acct; 60].join(","));
        let pool = parse_pool_json(&json, 0).unwrap();
        assert_eq!(pool.accounts.len(), 50);
        assert_eq!(pool.accounts[0].requests.len(), 30);
    }
}
