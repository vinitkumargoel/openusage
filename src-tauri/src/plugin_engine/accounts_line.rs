//! The `accounts` line: one row per stored login, each with a few percent
//! bars and a Switch button. Row ids are what the app passes to cswap, so
//! they are validated here, not trusted from the plugin.

use crate::cswap;
use rquickjs::{Ctx, Object, Value};
use serde::{Deserialize, Serialize};

const MAX_ROWS: usize = 50;
const MAX_BARS: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountBar {
    pub label: String,
    pub used: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountRow {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default)]
    pub active: bool,
    /// Short warning tag, e.g. "limit" or "expired".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flag: Option<String>,
    #[serde(default)]
    pub bars: Vec<AccountBar>,
}

pub(crate) fn parse_rows_json(json: &str, line_idx: usize) -> Result<Vec<AccountRow>, String> {
    let mut rows: Vec<AccountRow> = serde_json::from_str(json)
        .map_err(|e| format!("accounts line at index {line_idx}: invalid rows: {e}"))?;
    rows.truncate(MAX_ROWS);
    for row in &mut rows {
        if !cswap::is_valid_target(&row.id) || row.id == "best" {
            return Err(format!(
                "accounts line at index {line_idx}: row id must be a slot number, got '{}'",
                row.id
            ));
        }
        row.bars.truncate(MAX_BARS);
        for bar in &mut row.bars {
            if !bar.used.is_finite() {
                return Err(format!(
                    "accounts line at index {line_idx}: bar '{}' used must be a number",
                    bar.label
                ));
            }
            bar.used = bar.used.clamp(0.0, 100.0);
        }
    }
    Ok(rows)
}

pub(crate) fn parse_rows<'js>(
    ctx: &Ctx<'js>,
    line: &Object<'js>,
    line_idx: usize,
) -> Result<Vec<AccountRow>, String> {
    let rows: Value<'js> = line
        .get("rows")
        .map_err(|_| format!("accounts line at index {line_idx} missing rows array"))?;
    if !rows.is_array() {
        return Err(format!(
            "accounts line at index {line_idx} missing rows array"
        ));
    }
    let json = ctx
        .json_stringify(rows)
        .ok()
        .flatten()
        .and_then(|s| s.to_string().ok())
        .ok_or_else(|| format!("accounts line at index {line_idx}: rows not serializable"))?;
    parse_rows_json(&json, line_idx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rows_and_clamps_bars() {
        let rows = parse_rows_json(
            r#"[{"id":"2","name":"work","detail":"w@x.com","active":true,
                 "bars":[{"label":"5h","used":140,"resetsAt":"2026-10-07T20:00:00Z"},{"label":"7d","used":-3}]}]"#,
            0,
        )
        .unwrap();
        assert_eq!(rows[0].bars[0].used, 100.0);
        assert_eq!(rows[0].bars[1].used, 0.0);
        assert!(rows[0].active);
    }

    #[test]
    fn rejects_ids_cswap_would_not_accept() {
        for id in ["best", "0", "--purge", "1 2", ""] {
            let json = format!(r#"[{{"id":"{id}","name":"x"}}]"#);
            assert!(parse_rows_json(&json, 3).is_err(), "{id}");
        }
    }

    #[test]
    fn caps_rows_and_bars() {
        let row = r#"{"id":"1","name":"a","bars":[{"label":"a","used":1},{"label":"b","used":1},{"label":"c","used":1},{"label":"d","used":1}]}"#;
        let json = format!("[{}]", vec![row; 60].join(","));
        let rows = parse_rows_json(&json, 0).unwrap();
        assert_eq!(rows.len(), 50);
        assert_eq!(rows[0].bars.len(), 3);
    }
}
