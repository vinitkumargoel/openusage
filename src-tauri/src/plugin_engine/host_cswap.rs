//! `ctx.host.cswap.list()`: read-only access to `cswap list --json`.
//! Only the claude-accounts plugin gets it; switching stays in the app
//! command `switch_account`, never in plugin code.

use crate::cswap::{self, CswapError};
use crate::plugin_engine::host_api::ProbeDeadline;
use rquickjs::{Ctx, Function, Object};
use std::time::Duration;

const LIST_TIMEOUT: Duration = Duration::from_secs(20);

/// Wraps a cswap result as the `{status, ...}` object the plugin reads.
fn list_result_json(result: Result<String, CswapError>) -> String {
    let value = match result {
        Ok(out) => match serde_json::from_str::<serde_json::Value>(out.trim()) {
            Ok(data) => serde_json::json!({ "status": "ok", "data": data }),
            Err(_) => serde_json::json!({
                "status": "error",
                "message": "cswap returned invalid JSON",
            }),
        },
        Err(CswapError::NotInstalled) => serde_json::json!({ "status": "not_installed" }),
        Err(err) => serde_json::json!({ "status": "error", "message": err.message() }),
    };
    value.to_string()
}

pub(crate) fn inject_cswap<'js>(
    ctx: &Ctx<'js>,
    host: &Object<'js>,
    plugin_id: &str,
    deadline: ProbeDeadline,
) -> rquickjs::Result<()> {
    if plugin_id != cswap::PLUGIN_ID {
        return Ok(());
    }
    let obj = Object::new(ctx.clone())?;
    obj.set(
        "_listRaw",
        Function::new(ctx.clone(), move || -> rquickjs::Result<String> {
            let Some(timeout) = deadline.clamp_duration(LIST_TIMEOUT) else {
                return Ok(list_result_json(Err(CswapError::TimedOut)));
            };
            Ok(list_result_json(cswap::list(timeout)))
        })?,
    )?;
    host.set("cswap", obj)?;
    Ok(())
}

/// Adds `list()` on top of `_listRaw()`. No-op for plugins without cswap.
pub(crate) fn patch_cswap_wrapper(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.eval::<(), _>(
        r#"
        (function() {
            var cswap = __openusage_ctx.host.cswap;
            if (!cswap) return;
            cswap.list = function() { return JSON.parse(cswap._listRaw()); };
        })();
        "#
        .as_bytes(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: String) -> serde_json::Value {
        serde_json::from_str(&s).unwrap()
    }

    #[test]
    fn ok_wraps_parsed_payload() {
        let v = parse(list_result_json(Ok(
            r#"{"schemaVersion":1,"accounts":[]}"#.into()
        )));
        assert_eq!(v["status"], "ok");
        assert_eq!(v["data"]["schemaVersion"], 1);
    }

    #[test]
    fn not_installed_and_errors_are_explicit() {
        assert_eq!(
            parse(list_result_json(Err(CswapError::NotInstalled)))["status"],
            "not_installed"
        );
        let v = parse(list_result_json(Err(CswapError::TimedOut)));
        assert_eq!(v["status"], "error");
        assert_eq!(v["message"], "cswap timed out");
        assert_eq!(
            parse(list_result_json(Ok("not json".into())))["status"],
            "error"
        );
    }
}
