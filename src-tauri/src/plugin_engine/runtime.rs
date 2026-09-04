use crate::plugin_engine::host_api;
use crate::plugin_engine::manifest::LoadedPlugin;
use rquickjs::{Array, Context, Ctx, Error, Object, Promise, Runtime, Value};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const PROBE_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProgressFormat {
    Percent,
    Dollars,
    Count { suffix: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MetricLine {
    Text {
        label: String,
        value: String,
        color: Option<String>,
        subtitle: Option<String>,
    },
    Progress {
        label: String,
        used: f64,
        limit: f64,
        format: ProgressFormat,
        #[serde(rename = "resetsAt")]
        resets_at: Option<String>,
        #[serde(rename = "periodDurationMs")]
        period_duration_ms: Option<u64>,
        color: Option<String>,
    },
    Badge {
        label: String,
        text: String,
        color: Option<String>,
        subtitle: Option<String>,
    },
    Heatmap {
        label: String,
        days: Vec<HeatmapDay>,
        format: Option<ProgressFormat>,
        color: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeatmapDay {
    pub date: String,
    pub value: f64,
    /// Optional token count for the same day, shown alongside `value` and used
    /// when the user picks token units. Absent for plugins without token data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<f64>,
}

/// Cap on heatmap day entries per line — protects the IPC payload. ~400 days
/// covers a full year of history with room to spare.
const MAX_HEATMAP_DAYS: usize = 400;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOutput {
    pub provider_id: String,
    pub display_name: String,
    pub plan: Option<String>,
    pub lines: Vec<MetricLine>,
    pub icon_url: String,
}

pub fn run_probe(plugin: &LoadedPlugin, app_data_dir: &PathBuf, app_version: &str) -> PluginOutput {
    run_probe_with_timeout(
        plugin,
        app_data_dir,
        app_version,
        Duration::from_secs(PROBE_TIMEOUT_SECS),
    )
}

fn run_probe_with_timeout(
    plugin: &LoadedPlugin,
    app_data_dir: &PathBuf,
    app_version: &str,
    timeout: Duration,
) -> PluginOutput {
    let fallback = error_output(plugin, "runtime error".to_string());
    let timeout_message = probe_timeout_message(timeout);
    let deadline_at = Instant::now()
        .checked_add(timeout)
        .unwrap_or_else(Instant::now);
    let deadline = host_api::ProbeDeadline::at(deadline_at);

    let rt = match Runtime::new() {
        Ok(rt) => rt,
        Err(_) => return fallback,
    };
    rt.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline_at)));

    let ctx = match Context::full(&rt) {
        Ok(ctx) => ctx,
        Err(_) => return fallback,
    };

    let plugin_id = plugin.manifest.id.clone();
    let display_name = plugin.manifest.name.clone();
    let entry_script = plugin.entry_script.clone();
    let icon_url = plugin.icon_data_url.clone();
    let app_data = app_data_dir.clone();

    ctx.with(|ctx| {
        if host_api::inject_host_api_with_deadline(
            &ctx,
            &plugin_id,
            &app_data,
            app_version,
            deadline,
        )
        .is_err()
        {
            if deadline.has_elapsed() {
                return error_output(plugin, timeout_message.clone());
            }
            return error_output(plugin, "host api injection failed".to_string());
        }
        if host_api::patch_http_wrapper(&ctx).is_err() {
            if deadline.has_elapsed() {
                return error_output(plugin, timeout_message.clone());
            }
            return error_output(plugin, "http wrapper patch failed".to_string());
        }
        if host_api::patch_ls_wrapper(&ctx).is_err() {
            if deadline.has_elapsed() {
                return error_output(plugin, timeout_message.clone());
            }
            return error_output(plugin, "ls wrapper patch failed".to_string());
        }
        if host_api::patch_ccusage_wrapper(&ctx).is_err() {
            if deadline.has_elapsed() {
                return error_output(plugin, timeout_message.clone());
            }
            return error_output(plugin, "ccusage wrapper patch failed".to_string());
        }
        if host_api::inject_utils(&ctx).is_err() {
            if deadline.has_elapsed() {
                return error_output(plugin, timeout_message.clone());
            }
            return error_output(plugin, "utils injection failed".to_string());
        }

        if ctx.eval::<(), _>(entry_script.as_bytes()).is_err() {
            if deadline.has_elapsed() {
                return error_output(plugin, timeout_message.clone());
            }
            return error_output(plugin, "script eval failed".to_string());
        }

        let globals = ctx.globals();
        let plugin_obj: Object = match globals.get("__openusage_plugin") {
            Ok(obj) => obj,
            Err(_) => return error_output(plugin, "missing __openusage_plugin".to_string()),
        };

        let probe_fn: rquickjs::Function = match plugin_obj.get("probe") {
            Ok(f) => f,
            Err(_) => return error_output(plugin, "missing probe()".to_string()),
        };

        let probe_ctx: Value = globals
            .get("__openusage_ctx")
            .unwrap_or_else(|_| Value::new_undefined(ctx.clone()));

        let result_value: Value = match probe_fn.call((probe_ctx,)) {
            Ok(r) => r,
            Err(_) => {
                if deadline.has_elapsed() {
                    return error_output(plugin, timeout_message.clone());
                }
                return error_output(plugin, extract_error_string(&ctx));
            }
        };
        if deadline.has_elapsed() {
            return error_output(plugin, timeout_message.clone());
        }
        let result: Object = if result_value.is_promise() {
            let promise: Promise = match result_value.into_promise() {
                Some(promise) => promise,
                None => {
                    return error_output(plugin, "probe() returned invalid promise".to_string());
                }
            };
            match promise.finish::<Object>() {
                Ok(obj) => obj,
                Err(Error::WouldBlock) => {
                    return error_output(plugin, "probe() returned unresolved promise".to_string());
                }
                Err(_) => {
                    if deadline.has_elapsed() {
                        return error_output(plugin, timeout_message.clone());
                    }
                    return error_output(plugin, extract_error_string(&ctx));
                }
            }
        } else {
            match result_value.into_object() {
                Some(obj) => obj,
                None => return error_output(plugin, "probe() returned non-object".to_string()),
            }
        };
        if deadline.has_elapsed() {
            return error_output(plugin, timeout_message.clone());
        }

        let plan: Option<String> = result
            .get::<_, String>("plan")
            .ok()
            .filter(|s| !s.is_empty());

        let lines = match parse_lines(&result) {
            Ok(lines) if !lines.is_empty() => lines,
            Ok(_) => vec![error_line("no lines returned".to_string())],
            Err(msg) => vec![error_line(msg)],
        };

        PluginOutput {
            provider_id: plugin_id,
            display_name,
            plan,
            lines,
            icon_url,
        }
    })
}

fn parse_lines(result: &Object) -> Result<Vec<MetricLine>, String> {
    let lines: Array = result
        .get("lines")
        .map_err(|_| "missing lines".to_string())?;

    let mut out = Vec::new();
    let len = lines.len();
    for idx in 0..len {
        let line: Object = lines
            .get(idx)
            .map_err(|_| format!("invalid line at index {}", idx))?;

        let line_type: String = line.get("type").unwrap_or_default();
        let label = line.get::<_, String>("label").unwrap_or_default();
        let color = line.get::<_, String>("color").ok();
        let subtitle = line.get::<_, String>("subtitle").ok();

        match line_type.as_str() {
            "text" => {
                let value = line.get::<_, String>("value").unwrap_or_default();
                out.push(MetricLine::Text {
                    label,
                    value,
                    color,
                    subtitle,
                });
            }
            "progress" => {
                let used_value: Value = match line.get("used") {
                    Ok(v) => v,
                    Err(_) => {
                        out.push(error_line(format!(
                            "progress line at index {} missing used",
                            idx
                        )));
                        continue;
                    }
                };
                let used = match used_value.as_number() {
                    Some(n) => n,
                    None => {
                        out.push(error_line(format!(
                            "progress line at index {} invalid used (expected number)",
                            idx
                        )));
                        continue;
                    }
                };

                let limit_value: Value = match line.get("limit") {
                    Ok(v) => v,
                    Err(_) => {
                        out.push(error_line(format!(
                            "progress line at index {} missing limit",
                            idx
                        )));
                        continue;
                    }
                };
                let limit = match limit_value.as_number() {
                    Some(n) => n,
                    None => {
                        out.push(error_line(format!(
                            "progress line at index {} invalid limit (expected number)",
                            idx
                        )));
                        continue;
                    }
                };

                if !used.is_finite() || used < 0.0 {
                    out.push(error_line(format!(
                        "progress line at index {} invalid used: {}",
                        idx, used
                    )));
                    continue;
                }
                if !limit.is_finite() || limit <= 0.0 {
                    out.push(error_line(format!(
                        "progress line at index {} invalid limit: {}",
                        idx, limit
                    )));
                    continue;
                }

                let format_obj: Object = match line.get("format") {
                    Ok(obj) => obj,
                    Err(_) => {
                        out.push(error_line(format!(
                            "progress line at index {} missing format",
                            idx
                        )));
                        continue;
                    }
                };
                let kind_value: Value = match format_obj.get("kind") {
                    Ok(v) => v,
                    Err(_) => {
                        out.push(error_line(format!(
                            "progress line at index {} missing format.kind",
                            idx
                        )));
                        continue;
                    }
                };
                let kind = match kind_value.as_string() {
                    Some(s) => s.to_string().unwrap_or_default(),
                    None => {
                        out.push(error_line(format!(
                            "progress line at index {} invalid format.kind (expected string)",
                            idx
                        )));
                        continue;
                    }
                };
                let format = match kind.as_str() {
                    "percent" => {
                        if limit != 100.0 {
                            out.push(error_line(format!(
                                "progress line at index {}: percent format requires limit=100 (got {})",
                                idx, limit
                            )));
                            continue;
                        }
                        ProgressFormat::Percent
                    }
                    "dollars" => ProgressFormat::Dollars,
                    "count" => {
                        let suffix_value: Value = match format_obj.get("suffix") {
                            Ok(v) => v,
                            Err(_) => {
                                out.push(error_line(format!(
                                    "progress line at index {}: count format missing suffix",
                                    idx
                                )));
                                continue;
                            }
                        };
                        let suffix = match suffix_value.as_string() {
                            Some(s) => s.to_string().unwrap_or_default(),
                            None => {
                                out.push(error_line(format!(
                                    "progress line at index {}: count format suffix must be a string",
                                    idx
                                )));
                                continue;
                            }
                        };
                        let suffix = suffix.trim().to_string();
                        if suffix.is_empty() {
                            out.push(error_line(format!(
                                "progress line at index {}: count format suffix must be non-empty",
                                idx
                            )));
                            continue;
                        }
                        ProgressFormat::Count { suffix }
                    }
                    _ => {
                        out.push(error_line(format!(
                            "progress line at index {} invalid format.kind: {}",
                            idx, kind
                        )));
                        continue;
                    }
                };

                let resets_at = match line.get::<_, Value>("resetsAt") {
                    Ok(v) => {
                        if v.is_null() || v.is_undefined() {
                            None
                        } else if let Some(s) = v.as_string() {
                            let raw = s.to_string().unwrap_or_default();
                            let value = raw.trim().to_string();
                            if value.is_empty() {
                                None
                            } else {
                                let parsed = time::OffsetDateTime::parse(
                                    &value,
                                    &time::format_description::well_known::Rfc3339,
                                );
                                if parsed.is_ok() {
                                    Some(value)
                                } else {
                                    // ISO-like but missing timezone: assume UTC.
                                    let is_missing_tz =
                                        value.contains('T') && !value.ends_with('Z') && {
                                            let tail = value.splitn(2, 'T').nth(1).unwrap_or("");
                                            !tail.contains('+') && !tail.contains('-')
                                        };
                                    if is_missing_tz {
                                        let with_z = format!("{}Z", value);
                                        let parsed_with_z = time::OffsetDateTime::parse(
                                            &with_z,
                                            &time::format_description::well_known::Rfc3339,
                                        );
                                        if parsed_with_z.is_ok() {
                                            Some(with_z)
                                        } else {
                                            log::warn!(
                                                "invalid resetsAt at index {} (value='{}'), omitting",
                                                idx,
                                                raw
                                            );
                                            None
                                        }
                                    } else {
                                        log::warn!(
                                            "invalid resetsAt at index {} (value='{}'), omitting",
                                            idx,
                                            raw
                                        );
                                        None
                                    }
                                }
                            }
                        } else {
                            log::warn!("invalid resetsAt at index {} (non-string), omitting", idx);
                            None
                        }
                    }
                    Err(_) => None,
                };

                // Parse optional periodDurationMs
                let period_duration_ms: Option<u64> = match line.get::<_, Value>("periodDurationMs")
                {
                    Ok(val) => {
                        if val.is_null() || val.is_undefined() {
                            None
                        } else if let Some(n) = val.as_number() {
                            let ms = n as u64;
                            if ms > 0 {
                                Some(ms)
                            } else {
                                log::warn!(
                                    "periodDurationMs at index {} must be positive, omitting",
                                    idx
                                );
                                None
                            }
                        } else {
                            log::warn!(
                                "invalid periodDurationMs at index {} (non-number), omitting",
                                idx
                            );
                            None
                        }
                    }
                    Err(_) => None,
                };

                out.push(MetricLine::Progress {
                    label,
                    used,
                    limit,
                    format,
                    resets_at,
                    period_duration_ms,
                    color,
                });
            }
            "badge" => {
                let text = line.get::<_, String>("text").unwrap_or_default();
                out.push(MetricLine::Badge {
                    label,
                    text,
                    color,
                    subtitle,
                });
            }
            "heatmap" => {
                let days_array: Array = match line.get("days") {
                    Ok(arr) => arr,
                    Err(_) => {
                        out.push(error_line(format!(
                            "heatmap line at index {} missing days array",
                            idx
                        )));
                        continue;
                    }
                };
                let days = match parse_heatmap_days(&days_array, idx) {
                    Ok(days) => days,
                    Err(msg) => {
                        out.push(error_line(msg));
                        continue;
                    }
                };
                let format = match parse_heatmap_format(&line, idx) {
                    Ok(format) => format,
                    Err(msg) => {
                        out.push(error_line(msg));
                        continue;
                    }
                };
                out.push(MetricLine::Heatmap {
                    label,
                    days,
                    format,
                    color,
                });
            }
            _ => {
                out.push(error_line(format!(
                    "unknown line type at index {}: {}",
                    idx, line_type
                )));
            }
        }
    }

    Ok(out)
}

/// Day keys must be YYYY-MM-DD so the frontend can match them by string.
fn is_valid_day_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, b)| match i {
        4 | 7 => *b == b'-',
        _ => b.is_ascii_digit(),
    })
}

fn parse_heatmap_days(days_array: &Array, line_idx: usize) -> Result<Vec<HeatmapDay>, String> {
    let total = days_array.len();
    let take = total.min(MAX_HEATMAP_DAYS);
    if total > MAX_HEATMAP_DAYS {
        log::warn!(
            "heatmap line at index {} has {} days, keeping first {}",
            line_idx,
            total,
            MAX_HEATMAP_DAYS
        );
    }

    let mut days = Vec::with_capacity(take);
    for day_idx in 0..take {
        let entry: Object = days_array.get(day_idx).map_err(|_| {
            format!(
                "heatmap line at index {}: invalid day at index {}",
                line_idx, day_idx
            )
        })?;
        let date: String = entry.get("date").map_err(|_| {
            format!(
                "heatmap line at index {}: day at index {} missing date",
                line_idx, day_idx
            )
        })?;
        if !is_valid_day_key(&date) {
            return Err(format!(
                "heatmap line at index {}: day at index {} has invalid date '{}' (expected YYYY-MM-DD)",
                line_idx, day_idx, date
            ));
        }
        let value_raw: Value = entry.get("value").map_err(|_| {
            format!(
                "heatmap line at index {}: day at index {} missing value",
                line_idx, day_idx
            )
        })?;
        let value = value_raw.as_number().ok_or_else(|| {
            format!(
                "heatmap line at index {}: day at index {} invalid value (expected number)",
                line_idx, day_idx
            )
        })?;
        if !value.is_finite() || value < 0.0 {
            return Err(format!(
                "heatmap line at index {}: day at index {} invalid value: {}",
                line_idx, day_idx, value
            ));
        }
        let tokens = parse_heatmap_tokens(&entry, line_idx, day_idx)?;
        days.push(HeatmapDay {
            date,
            value,
            tokens,
        });
    }
    Ok(days)
}

/// Optional per-day token count. Missing/null is fine; a present-but-invalid
/// value is an error so plugin bugs stay loud.
fn parse_heatmap_tokens(
    entry: &Object,
    line_idx: usize,
    day_idx: usize,
) -> Result<Option<f64>, String> {
    let raw: Value = match entry.get("tokens") {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    if raw.is_null() || raw.is_undefined() {
        return Ok(None);
    }
    let tokens = raw.as_number().ok_or_else(|| {
        format!(
            "heatmap line at index {}: day at index {} invalid tokens (expected number)",
            line_idx, day_idx
        )
    })?;
    if !tokens.is_finite() || tokens < 0.0 {
        return Err(format!(
            "heatmap line at index {}: day at index {} invalid tokens: {}",
            line_idx, day_idx, tokens
        ));
    }
    Ok(Some(tokens))
}

fn parse_heatmap_format(line: &Object, line_idx: usize) -> Result<Option<ProgressFormat>, String> {
    let format_value: Value = match line.get("format") {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    if format_value.is_null() || format_value.is_undefined() {
        return Ok(None);
    }
    let format_obj = format_value.into_object().ok_or_else(|| {
        format!(
            "heatmap line at index {}: format must be an object",
            line_idx
        )
    })?;
    let kind: String = format_obj.get("kind").map_err(|_| {
        format!(
            "heatmap line at index {}: format missing kind",
            line_idx
        )
    })?;
    match kind.as_str() {
        "percent" => Ok(Some(ProgressFormat::Percent)),
        "dollars" => Ok(Some(ProgressFormat::Dollars)),
        "count" => {
            let suffix: String = format_obj.get("suffix").map_err(|_| {
                format!(
                    "heatmap line at index {}: count format missing suffix",
                    line_idx
                )
            })?;
            let suffix = suffix.trim().to_string();
            if suffix.is_empty() {
                return Err(format!(
                    "heatmap line at index {}: count format suffix must be non-empty",
                    line_idx
                ));
            }
            Ok(Some(ProgressFormat::Count { suffix }))
        }
        other => Err(format!(
            "heatmap line at index {} invalid format.kind: {}",
            line_idx, other
        )),
    }
}

fn error_output(plugin: &LoadedPlugin, message: String) -> PluginOutput {
    PluginOutput {
        provider_id: plugin.manifest.id.clone(),
        display_name: plugin.manifest.name.clone(),
        plan: None,
        lines: vec![error_line(message)],
        icon_url: plugin.icon_data_url.clone(),
    }
}

fn extract_error_string(ctx: &Ctx<'_>) -> String {
    let exc = ctx.catch();
    if exc.is_null() || exc.is_undefined() {
        return "The plugin failed, try again or contact plugin author.".to_string();
    }
    if let Some(str_val) = exc.as_string() {
        let message: String = str_val.to_string().unwrap_or_default();
        let trimmed = message.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "The plugin failed, try again or contact plugin author.".to_string()
}

fn probe_timeout_message(timeout: Duration) -> String {
    if timeout.subsec_millis() == 0 {
        return format!("probe timed out after {}s", timeout.as_secs());
    }
    if timeout.as_secs() == 0 {
        return format!("probe timed out after {}ms", timeout.as_millis());
    }
    format!("probe timed out after {:.3}s", timeout.as_secs_f64())
}

fn error_line(message: String) -> MetricLine {
    MetricLine::Badge {
        label: "Error".to_string(),
        text: message,
        color: Some("#ef4444".to_string()),
        subtitle: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_engine::manifest::{LoadedPlugin, PluginManifest};
    use serde_json::Value as JsonValue;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_plugin(entry_script: &str) -> LoadedPlugin {
        LoadedPlugin {
            manifest: PluginManifest {
                schema_version: 1,
                id: "test".to_string(),
                name: "Test".to_string(),
                version: "0.0.0".to_string(),
                entry: "plugin.js".to_string(),
                icon: "icon.svg".to_string(),
                brand_color: None,
                lines: vec![],
                links: vec![],
            },
            plugin_dir: PathBuf::from("."),
            entry_script: entry_script.to_string(),
            icon_data_url: "data:image/svg+xml;base64,".to_string(),
        }
    }

    fn temp_app_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("openusage-test-{}-{}", label, nanos))
    }

    fn error_text(output: PluginOutput) -> String {
        match output.lines.first() {
            Some(MetricLine::Badge { text, .. }) => text.clone(),
            other => panic!("expected error badge, got {:?}", other),
        }
    }

    #[test]
    fn run_probe_returns_thrown_string_from_sync_error() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() {
                    throw "boom";
                }
            };
            "#,
        );
        let output = run_probe(&plugin, &temp_app_dir("sync"), "0.0.0");
        assert_eq!(error_text(output), "boom");
    }

    #[test]
    fn run_probe_returns_thrown_string_from_async_error() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe: async function () {
                    throw "boom";
                }
            };
            "#,
        );
        let output = run_probe(&plugin, &temp_app_dir("async"), "0.0.0");
        assert_eq!(error_text(output), "boom");
    }

    #[test]
    fn run_probe_times_out_cpu_bound_script() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() {
                    while (true) {}
                }
            };
            "#,
        );

        let output = run_probe_with_timeout(
            &plugin,
            &temp_app_dir("timeout"),
            "0.0.0",
            Duration::from_millis(5),
        );

        assert_eq!(error_text(output), "probe timed out after 5ms");
    }

    #[test]
    fn progress_resets_at_serializes_as_resets_at_camelcase() {
        let line = MetricLine::Progress {
            label: "Session".to_string(),
            used: 1.0,
            limit: 100.0,
            format: ProgressFormat::Percent,
            resets_at: Some("2099-01-01T00:00:00.000Z".to_string()),
            period_duration_ms: None,
            color: None,
        };

        let json: JsonValue = serde_json::to_value(&line).expect("serialize");
        let obj = json.as_object().expect("object");
        assert!(obj.get("resetsAt").is_some(), "expected resetsAt key");
        assert!(
            obj.get("resets_at").is_none(),
            "did not expect resets_at key"
        );
    }

    #[test]
    fn heatmap_line_parses_days_and_format() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() {
                    return { lines: [{
                        type: "heatmap",
                        label: "Activity",
                        days: [
                            { date: "2026-08-27", value: 4.31 },
                            { date: "2026-08-26", value: 0 }
                        ],
                        format: { kind: "dollars" }
                    }] };
                }
            };
            "#,
        );
        let output = run_probe(&plugin, &temp_app_dir("heatmap-ok"), "0.0.0");
        match &output.lines[0] {
            MetricLine::Heatmap {
                label,
                days,
                format,
                ..
            } => {
                assert_eq!(label, "Activity");
                assert_eq!(days.len(), 2);
                assert_eq!(days[0].date, "2026-08-27");
                assert!((days[0].value - 4.31).abs() < 1e-9);
                assert_eq!(days[1].value, 0.0);
                assert!(matches!(format, Some(ProgressFormat::Dollars)));
            }
            other => panic!("expected heatmap line, got {:?}", other),
        }
    }

    #[test]
    fn heatmap_line_without_format_parses_as_none() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() {
                    return { lines: [{
                        type: "heatmap",
                        label: "Activity",
                        days: [{ date: "2026-08-27", value: 1 }]
                    }] };
                }
            };
            "#,
        );
        let output = run_probe(&plugin, &temp_app_dir("heatmap-nofmt"), "0.0.0");
        match &output.lines[0] {
            MetricLine::Heatmap { format, .. } => assert!(format.is_none()),
            other => panic!("expected heatmap line, got {:?}", other),
        }
    }

    #[test]
    fn heatmap_line_with_invalid_date_becomes_error_line() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() {
                    return { lines: [{
                        type: "heatmap",
                        label: "Activity",
                        days: [{ date: "Feb 12, 2026", value: 1 }]
                    }] };
                }
            };
            "#,
        );
        let output = run_probe(&plugin, &temp_app_dir("heatmap-baddate"), "0.0.0");
        assert!(error_text(output).contains("invalid date"));
    }

    #[test]
    fn heatmap_line_with_negative_value_becomes_error_line() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() {
                    return { lines: [{
                        type: "heatmap",
                        label: "Activity",
                        days: [{ date: "2026-08-27", value: -1 }]
                    }] };
                }
            };
            "#,
        );
        let output = run_probe(&plugin, &temp_app_dir("heatmap-negative"), "0.0.0");
        assert!(error_text(output).contains("invalid value"));
    }

    #[test]
    fn heatmap_line_missing_days_becomes_error_line() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() {
                    return { lines: [{ type: "heatmap", label: "Activity" }] };
                }
            };
            "#,
        );
        let output = run_probe(&plugin, &temp_app_dir("heatmap-nodays"), "0.0.0");
        assert!(error_text(output).contains("missing days"));
    }

    #[test]
    fn heatmap_days_are_capped_at_400_entries() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() {
                    var days = [];
                    for (var i = 0; i < 401; i++) {
                        days.push({ date: "2026-01-01", value: 1 });
                    }
                    return { lines: [{ type: "heatmap", label: "Activity", days: days }] };
                }
            };
            "#,
        );
        let output = run_probe(&plugin, &temp_app_dir("heatmap-cap"), "0.0.0");
        match &output.lines[0] {
            MetricLine::Heatmap { days, .. } => assert_eq!(days.len(), 400),
            other => panic!("expected heatmap line, got {:?}", other),
        }
    }

    #[test]
    fn heatmap_line_serializes_with_camelcase_tag() {
        let line = MetricLine::Heatmap {
            label: "Activity".to_string(),
            days: vec![HeatmapDay {
                date: "2026-08-27".to_string(),
                value: 4.31,
                tokens: Some(3_400_000.0),
            }],
            format: Some(ProgressFormat::Dollars),
            color: None,
        };
        let json: JsonValue = serde_json::to_value(&line).expect("serialize");
        let obj = json.as_object().expect("object");
        assert_eq!(obj.get("type").and_then(|v| v.as_str()), Some("heatmap"));
        let day = obj.get("days").and_then(|v| v.as_array()).expect("days")[0]
            .as_object()
            .expect("day object");
        assert_eq!(day.get("date").and_then(|v| v.as_str()), Some("2026-08-27"));
        assert!(day.get("value").is_some());
        assert_eq!(
            day.get("tokens").and_then(|v| v.as_f64()),
            Some(3_400_000.0)
        );
    }

    #[test]
    fn heatmap_day_tokens_are_optional() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() {
                    return {
                        lines: [{
                            type: "heatmap",
                            label: "Activity",
                            days: [
                                { date: "2026-08-26", value: 1.5, tokens: 120000 },
                                { date: "2026-08-27", value: 2.5 }
                            ],
                            format: { kind: "dollars" }
                        }]
                    };
                }
            };
            "#,
        );
        let output = run_probe(&plugin, &temp_app_dir("heatmap-tokens"), "0.0.0");
        match &output.lines[0] {
            MetricLine::Heatmap { days, .. } => {
                assert_eq!(days[0].tokens, Some(120000.0));
                assert_eq!(days[1].tokens, None);
            }
            other => panic!("expected heatmap line, got {:?}", other),
        }
    }

    #[test]
    fn heatmap_day_with_negative_tokens_becomes_error_line() {
        let plugin = test_plugin(
            r#"
            globalThis.__openusage_plugin = {
                probe() {
                    return {
                        lines: [{
                            type: "heatmap",
                            label: "Activity",
                            days: [{ date: "2026-08-27", value: 1, tokens: -5 }]
                        }]
                    };
                }
            };
            "#,
        );
        let output = run_probe(&plugin, &temp_app_dir("heatmap-bad-tokens"), "0.0.0");
        assert!(error_text(output).contains("invalid tokens"));
    }
}
