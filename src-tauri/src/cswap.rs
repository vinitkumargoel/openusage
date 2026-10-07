//! Runs the `cswap` (claude-swap) CLI, which keeps several Claude Code logins
//! and swaps the active one. Only two fixed commands are ever run:
//! `cswap list --json` and `cswap switch <n|best> --json`.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const PLUGIN_ID: &str = "claude-accounts";
/// Providers whose numbers change when the active Claude login changes.
pub const AFFECTED_PLUGIN_IDS: [&str; 2] = [PLUGIN_ID, "claude"];

const SWITCH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq)]
pub enum CswapError {
    NotInstalled,
    TimedOut,
    Failed(String),
}

impl CswapError {
    pub fn message(&self) -> String {
        match self {
            CswapError::NotInstalled => {
                "cswap not found. Install claude-swap (uv tool install claude-swap).".to_string()
            }
            CswapError::TimedOut => "cswap timed out".to_string(),
            CswapError::Failed(msg) => msg.clone(),
        }
    }
}

/// GUI apps don't inherit the shell PATH, so look in the usual install spots.
fn find_binary() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/cswap"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/cswap"));
    candidates.push(PathBuf::from("/usr/local/bin/cswap"));
    candidates.into_iter().find(|p| p.is_file())
}

/// `best` or an account slot number (1-999).
pub fn is_valid_target(target: &str) -> bool {
    if target == "best" {
        return true;
    }
    !target.is_empty()
        && target.len() <= 3
        && target.bytes().all(|b| b.is_ascii_digit())
        && target != "0"
        && !target.starts_with('0')
}

/// Runs cswap and returns its stdout. With `--json`, cswap prints an error
/// payload on stdout and exits non-zero, so stdout wins over stderr when set.
fn run(args: &[&str], timeout: Duration) -> Result<String, CswapError> {
    let binary = find_binary().ok_or(CswapError::NotInstalled)?;
    let mut child = Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CswapError::Failed(format!("cswap failed to start: {e}")))?;

    // Drain both pipes while waiting so a full buffer can't stall the child.
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let out_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CswapError::TimedOut);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(CswapError::Failed(format!("cswap wait failed: {e}"))),
        }
    };
    let out = out_reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();

    if !out.trim().is_empty() {
        return Ok(out);
    }
    if status.success() {
        return Err(CswapError::Failed("cswap printed nothing".to_string()));
    }
    let first_line = err.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    Err(CswapError::Failed(format!(
        "cswap exited with {status}: {}",
        first_line.trim()
    )))
}

pub fn list(timeout: Duration) -> Result<String, CswapError> {
    run(&["list", "--json"], timeout)
}

pub fn switch(target: &str) -> Result<serde_json::Value, CswapError> {
    if !is_valid_target(target) {
        return Err(CswapError::Failed(format!(
            "invalid switch target: {target}"
        )));
    }
    let out = run(&["switch", target, "--json"], SWITCH_TIMEOUT)?;
    let payload: serde_json::Value = serde_json::from_str(out.trim())
        .map_err(|_| CswapError::Failed("cswap returned invalid JSON".to_string()))?;
    if let Some(error) = payload.get("error") {
        let msg = error
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("cswap switch failed");
        return Err(CswapError::Failed(msg.to_string()));
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_best_and_slot_numbers() {
        for t in ["best", "1", "5", "42", "999"] {
            assert!(is_valid_target(t), "{t}");
        }
    }

    #[test]
    fn rejects_anything_else() {
        for t in [
            "", "0", "01", "1000", "-1", "2 --json", "best;rm", "a", "--debug", "1.5",
        ] {
            assert!(!is_valid_target(t), "{t}");
        }
    }

    #[test]
    fn invalid_target_never_runs_cswap() {
        let err = switch("--purge").unwrap_err();
        assert_eq!(
            err,
            CswapError::Failed("invalid switch target: --purge".to_string())
        );
    }
}
