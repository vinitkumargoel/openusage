#[cfg(target_os = "macos")]
mod app_nap;
mod config;
mod cswap;
mod local_http_api;
mod panel;
mod plugin_engine;
mod tray;
#[cfg(target_os = "macos")]
mod webkit_config;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::Emitter;
use tauri_plugin_log::{Target, TargetKind};
use uuid::Uuid;

#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const GLOBAL_SHORTCUT_STORE_KEY: &str = "globalShortcut";
const MAX_CONCURRENT_PROBES: usize = 4;

fn probe_worker_count(plugin_count: usize) -> usize {
    plugin_count.min(MAX_CONCURRENT_PROBES)
}

#[cfg(desktop)]
fn managed_shortcut_slot() -> &'static Mutex<Option<String>> {
    static SLOT: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Shared shortcut handler that toggles the panel when the shortcut is pressed.
#[cfg(desktop)]
fn handle_global_shortcut(
    app: &tauri::AppHandle,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    if event.state == ShortcutState::Pressed {
        log::debug!("Global shortcut triggered");
        panel::toggle_panel(app);
    }
}

pub struct AppState {
    pub plugins: Vec<plugin_engine::manifest::LoadedPlugin>,
    pub app_data_dir: PathBuf,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMeta {
    pub id: String,
    pub name: String,
    pub icon_url: String,
    pub brand_color: Option<String>,
    pub lines: Vec<ManifestLineDto>,
    pub links: Vec<PluginLinkDto>,
    /// Ordered list of primary metric candidates (sorted by primaryOrder).
    /// Frontend picks the first one that exists in runtime data.
    pub primary_candidates: Vec<String>,
    /// Fields the Settings page renders for this plugin, if it declares any.
    pub settings: Vec<PluginSettingFieldDto>,
    /// Card layout, e.g. "ledger". None = default list.
    pub layout: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettingFieldDto {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub placeholder: Option<String>,
    pub help: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestLineDto {
    #[serde(rename = "type")]
    pub line_type: String,
    pub label: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLinkDto {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeBatchStarted {
    pub batch_id: String,
    pub plugin_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub batch_id: String,
    pub output: plugin_engine::runtime::PluginOutput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeBatchComplete {
    pub batch_id: String,
}

#[tauri::command]
fn init_panel(app_handle: tauri::AppHandle) {
    panel::init(&app_handle).expect("Failed to initialize panel");
}

#[tauri::command]
fn hide_panel(app_handle: tauri::AppHandle) {
    use tauri_nspanel::ManagerExt;
    if let Ok(panel) = app_handle.get_webview_panel("main") {
        panel.hide();
    }
}

#[tauri::command]
fn open_devtools(#[allow(unused)] app_handle: tauri::AppHandle) {
    #[cfg(debug_assertions)]
    {
        use tauri::Manager;
        if let Some(window) = app_handle.get_webview_window("main") {
            window.open_devtools();
        }
    }
}

#[tauri::command]
async fn start_probe_batch(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    batch_id: Option<String>,
    plugin_ids: Option<Vec<String>>,
) -> Result<ProbeBatchStarted, String> {
    let batch_id = batch_id
        .and_then(|id| {
            let trimmed = id.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let (plugins, app_data_dir, app_version) = {
        let locked = state.lock().map_err(|e| e.to_string())?;
        (
            locked.plugins.clone(),
            locked.app_data_dir.clone(),
            locked.app_version.clone(),
        )
    };

    let selected_plugins = match plugin_ids {
        Some(ids) => {
            let mut by_id: HashMap<String, plugin_engine::manifest::LoadedPlugin> = plugins
                .into_iter()
                .map(|plugin| (plugin.manifest.id.clone(), plugin))
                .collect();
            let mut seen = HashSet::new();
            ids.into_iter()
                .filter_map(|id| {
                    if !seen.insert(id.clone()) {
                        return None;
                    }
                    by_id.remove(&id)
                })
                .collect()
        }
        None => plugins,
    };

    let response_plugin_ids: Vec<String> = selected_plugins
        .iter()
        .map(|plugin| plugin.manifest.id.clone())
        .collect();

    log::info!(
        "probe batch {} starting: {:?}",
        batch_id,
        response_plugin_ids
    );

    if selected_plugins.is_empty() {
        let _ = app_handle.emit(
            "probe:batch-complete",
            ProbeBatchComplete {
                batch_id: batch_id.clone(),
            },
        );
        return Ok(ProbeBatchStarted {
            batch_id,
            plugin_ids: response_plugin_ids,
        });
    }

    let selected_count = selected_plugins.len();
    let worker_count = probe_worker_count(selected_count);
    if worker_count < selected_count {
        log::info!(
            "probe batch {} using {} workers for {} plugins",
            batch_id,
            worker_count,
            selected_count
        );
    }

    let remaining = Arc::new(AtomicUsize::new(selected_count));
    let probe_queue = Arc::new(Mutex::new(
        selected_plugins.into_iter().collect::<VecDeque<_>>(),
    ));

    for _ in 0..worker_count {
        let handle = app_handle.clone();
        let completion_handle = app_handle.clone();
        let bid = batch_id.clone();
        let completion_bid = batch_id.clone();
        let data_dir = app_data_dir.clone();
        let version = app_version.clone();
        let counter = Arc::clone(&remaining);
        let queue = Arc::clone(&probe_queue);

        tauri::async_runtime::spawn_blocking(move || {
            loop {
                let plugin = {
                    let mut queue = queue
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    queue.pop_front()
                };

                let Some(plugin) = plugin else {
                    break;
                };

                let plugin_id = plugin.manifest.id.clone();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    plugin_engine::runtime::run_probe(&plugin, &data_dir, &version)
                }));

                match result {
                    Ok(output) => {
                        let has_error = output.lines.iter().any(|line| {
                            matches!(line, plugin_engine::runtime::MetricLine::Badge { label, .. } if label == "Error")
                        });
                        if has_error {
                            log::warn!("probe {} completed with error", plugin_id);
                        } else {
                            log::info!(
                                "probe {} completed ok ({} lines)",
                                plugin_id,
                                output.lines.len()
                            );
                            local_http_api::cache_successful_output(&output);
                        }
                        let _ = handle.emit(
                            "probe:result",
                            ProbeResult {
                                batch_id: bid.clone(),
                                output,
                            },
                        );
                    }
                    Err(_) => {
                        log::error!("probe {} panicked", plugin_id);
                    }
                }

                if counter.fetch_sub(1, Ordering::SeqCst) == 1 {
                    log::info!("probe batch {} complete", completion_bid);
                    let _ = completion_handle.emit(
                        "probe:batch-complete",
                        ProbeBatchComplete {
                            batch_id: completion_bid.clone(),
                        },
                    );
                }
            }
        });
    }

    Ok(ProbeBatchStarted {
        batch_id,
        plugin_ids: response_plugin_ids,
    })
}

#[tauri::command]
fn get_log_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    // macOS log directory: ~/Library/Logs/{bundleIdentifier}
    let home = dirs::home_dir().ok_or("no home dir")?;
    let bundle_id = app_handle.config().identifier.clone();
    let log_dir = home.join("Library").join("Logs").join(&bundle_id);
    let log_file = log_dir.join(format!("{}.log", app_handle.package_info().name));
    Ok(log_file.to_string_lossy().to_string())
}

/// Update the global shortcut registration.
/// Pass `null` to disable the shortcut, or a shortcut string like "CommandOrControl+Shift+U".
#[cfg(desktop)]
#[tauri::command]
fn update_global_shortcut(
    app_handle: tauri::AppHandle,
    shortcut: Option<String>,
) -> Result<(), String> {
    let global_shortcut = app_handle.global_shortcut();
    let normalized_shortcut = shortcut.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let mut managed_shortcut = managed_shortcut_slot()
        .lock()
        .map_err(|e| format!("failed to lock managed shortcut state: {}", e))?;

    if *managed_shortcut == normalized_shortcut {
        log::debug!("Global shortcut unchanged");
        return Ok(());
    }

    let previous_shortcut = managed_shortcut.clone();
    if let Some(existing) = previous_shortcut.as_deref() {
        match global_shortcut.unregister(existing) {
            Ok(()) => {
                // Keep in-memory state aligned with actual registration state.
                *managed_shortcut = None;
            }
            Err(e) => {
                log::warn!(
                    "Failed to unregister existing shortcut '{}': {}",
                    existing,
                    e
                );
            }
        }
    }

    if let Some(shortcut) = normalized_shortcut {
        log::info!("Registering global shortcut: {}", shortcut);
        global_shortcut
            .on_shortcut(shortcut.as_str(), |app, _shortcut, event| {
                handle_global_shortcut(app, event);
            })
            .map_err(|e| format!("Failed to register shortcut '{}': {}", shortcut, e))?;
        *managed_shortcut = Some(shortcut);
    } else {
        log::info!("Global shortcut disabled");
        *managed_shortcut = None;
    }

    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountSwitched {
    /// cswap's `{switched, from, to, reason}` payload.
    result: serde_json::Value,
    /// Providers to re-probe now that the active login changed.
    refresh_plugin_ids: Vec<String>,
}

/// Switches the active Claude Code login through cswap. Only the
/// claude-accounts provider can switch; `target` is a slot number or "best".
#[tauri::command]
async fn switch_account(provider_id: String, target: String) -> Result<AccountSwitched, String> {
    if provider_id != cswap::PLUGIN_ID {
        return Err(format!("{provider_id} does not support switching accounts"));
    }
    log::info!("switch_account: target={}", target);
    let result = tauri::async_runtime::spawn_blocking(move || cswap::switch(&target))
        .await
        .map_err(|e| format!("switch task failed: {e}"))?
        .map_err(|e| {
            log::warn!("switch_account failed: {}", e.message());
            e.message()
        })?;
    Ok(AccountSwitched {
        result,
        refresh_plugin_ids: cswap::AFFECTED_PLUGIN_IDS.iter().map(|s| s.to_string()).collect(),
    })
}

#[tauri::command]
fn list_plugins(state: tauri::State<'_, Mutex<AppState>>) -> Vec<PluginMeta> {
    let plugins = {
        let locked = state.lock().expect("plugin state poisoned");
        locked.plugins.clone()
    };
    log::debug!("list_plugins: {} plugins", plugins.len());

    plugins
        .into_iter()
        .map(|plugin| {
            // Extract primary candidates: progress lines with primary_order, sorted by order
            let mut candidates: Vec<_> = plugin
                .manifest
                .lines
                .iter()
                .filter(|line| line.line_type == "progress" && line.primary_order.is_some())
                .collect();
            candidates.sort_by_key(|line| line.primary_order.unwrap());
            let primary_candidates: Vec<String> =
                candidates.iter().map(|line| line.label.clone()).collect();

            PluginMeta {
                id: plugin.manifest.id,
                name: plugin.manifest.name,
                icon_url: plugin.icon_data_url,
                brand_color: plugin.manifest.brand_color,
                lines: plugin
                    .manifest
                    .lines
                    .iter()
                    .map(|line| ManifestLineDto {
                        line_type: line.line_type.clone(),
                        label: line.label.clone(),
                        scope: line.scope.clone(),
                    })
                    .collect(),
                links: plugin
                    .manifest
                    .links
                    .iter()
                    .map(|link| PluginLinkDto {
                        label: link.label.clone(),
                        url: link.url.clone(),
                    })
                    .collect(),
                primary_candidates,
                settings: plugin
                    .manifest
                    .settings
                    .iter()
                    .map(|field| PluginSettingFieldDto {
                        key: field.key.clone(),
                        label: field.label.clone(),
                        field_type: field.field_type.clone(),
                        placeholder: field.placeholder.clone(),
                        help: field.help.clone(),
                    })
                    .collect(),
                layout: plugin.manifest.layout,
            }
        })
        .collect()
}

/// The declared setting keys of a plugin, or an error when the plugin is
/// unknown — which is also what keeps `plugin_id` from becoming a path.
fn plugin_setting_keys(
    state: &tauri::State<'_, Mutex<AppState>>,
    plugin_id: &str,
) -> Result<(PathBuf, Vec<String>), String> {
    let locked = state.lock().map_err(|_| "plugin state poisoned".to_string())?;
    let plugin = locked
        .plugins
        .iter()
        .find(|p| p.manifest.id == plugin_id)
        .ok_or_else(|| format!("unknown plugin: {}", plugin_id))?;
    let keys = plugin
        .manifest
        .settings
        .iter()
        .map(|field| field.key.clone())
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return Err(format!("plugin {} declares no settings", plugin_id));
    }
    let path = locked
        .app_data_dir
        .join("plugins_data")
        .join(plugin_id)
        .join("config.json");
    Ok((path, keys))
}

fn read_plugin_config_file(path: &PathBuf) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let text = std::fs::read_to_string(path).map_err(|err| format!("read config: {}", err))?;
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        Ok(_) => Err("config.json is not a JSON object".to_string()),
        Err(err) => Err(format!("config.json is not valid JSON: {}", err)),
    }
}

/// Writes the plugin config with owner-only permissions; the temp-then-rename
/// keeps a half-written file from ever being what the plugin reads.
fn write_plugin_config_file(
    path: &PathBuf,
    map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "config path has no parent".to_string())?;
    std::fs::create_dir_all(dir).map_err(|err| format!("create plugin data dir: {}", err))?;
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(map.clone()))
        .map_err(|err| format!("serialize config: {}", err))?;
    let tmp = path.with_extension("json.tmp");
    // Created 0600 up front: the file holds secrets, so it must never exist at
    // the default 0644, not even for the instant before a chmod.
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let write = opts.open(&tmp).and_then(|mut file| {
        use std::io::Write;
        file.write_all(text.as_bytes())
    });
    if let Err(err) = write {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("write config: {}", err));
    }
    if let Err(err) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("replace config: {}", err));
    }
    Ok(())
}

/// Declared settings values for a plugin. Values are never logged.
#[tauri::command]
fn get_plugin_config(
    state: tauri::State<'_, Mutex<AppState>>,
    plugin_id: String,
) -> Result<HashMap<String, String>, String> {
    let (path, keys) = plugin_setting_keys(&state, &plugin_id)?;
    let map = read_plugin_config_file(&path)?;
    let mut out = HashMap::new();
    for key in keys {
        if let Some(serde_json::Value::String(value)) = map.get(&key) {
            out.insert(key, value.clone());
        }
    }
    Ok(out)
}

/// Merges declared settings into the plugin's config.json, keeping any other
/// keys the file already has. An empty value removes the key.
#[tauri::command]
fn set_plugin_config(
    state: tauri::State<'_, Mutex<AppState>>,
    plugin_id: String,
    values: HashMap<String, String>,
) -> Result<(), String> {
    let (path, keys) = plugin_setting_keys(&state, &plugin_id)?;
    let mut map = read_plugin_config_file(&path)?;
    for (key, value) in values {
        if !keys.contains(&key) {
            return Err(format!("plugin {} has no setting '{}'", plugin_id, key));
        }
        let trimmed = value.trim();
        if trimmed.is_empty() {
            map.remove(&key);
        } else {
            map.insert(key, serde_json::Value::String(trimmed.to_string()));
        }
    }
    write_plugin_config_file(&path, &map)?;
    log::info!("[plugin:{}] settings saved", plugin_id);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
    let _guard = runtime.enter();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_nspanel::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                ])
                .max_file_size(10_000_000) // 10 MB
                .level(log::LevelFilter::Trace) // Allow all levels; runtime filter via tray menu
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("tao", log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            init_panel,
            hide_panel,
            open_devtools,
            start_probe_batch,
            list_plugins,
            get_log_path,
            update_global_shortcut,
            get_plugin_config,
            set_plugin_config,
            switch_account
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "macos")]
            {
                app_nap::disable_app_nap();
                webkit_config::disable_webview_suspension(app.handle());
            }

            use tauri::Manager;

            let version = app.package_info().version.to_string();
            log::info!("OpenUsage v{} starting", version);

            // Load config early (lazy init via OnceLock, zero-cost after)
            let _proxy = config::get_resolved_proxy();

            let app_data_dir = app.path().app_data_dir().expect("no app data dir");
            let resource_dir = app.path().resource_dir().expect("no resource dir");
            let app_data_dir_tail = app_data_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("unknown");
            let redacted_app_data_dir =
                plugin_engine::host_api::redact_log_message(&app_data_dir.display().to_string());
            log::debug!(
                "app_data_dir: tail={}, path={}",
                app_data_dir_tail,
                redacted_app_data_dir
            );

            let (_, plugins) = plugin_engine::initialize_plugins(&app_data_dir, &resource_dir);
            let known_plugin_ids: Vec<String> =
                plugins.iter().map(|p| p.manifest.id.clone()).collect();
            app.manage(Mutex::new(AppState {
                plugins,
                app_data_dir: app_data_dir.clone(),
                app_version: app.package_info().version.to_string(),
            }));

            local_http_api::init(&app_data_dir, known_plugin_ids);
            local_http_api::start_server();

            tray::create(app.handle())?;

            // Register global shortcut from stored settings
            #[cfg(desktop)]
            {
                use tauri_plugin_store::StoreExt;

                if let Ok(store) = app.handle().store("settings.json") {
                    if let Some(shortcut_value) = store.get(GLOBAL_SHORTCUT_STORE_KEY) {
                        if let Some(shortcut) = shortcut_value.as_str() {
                            let shortcut = shortcut.trim();
                            if !shortcut.is_empty() {
                                let handle = app.handle().clone();
                                log::info!("Registering initial global shortcut: {}", shortcut);
                                if let Err(e) = handle.global_shortcut().on_shortcut(
                                    shortcut,
                                    |app, _shortcut, event| {
                                        handle_global_shortcut(app, event);
                                    },
                                ) {
                                    log::warn!("Failed to register initial global shortcut: {}", e);
                                } else if let Ok(mut managed_shortcut) =
                                    managed_shortcut_slot().lock()
                                {
                                    *managed_shortcut = Some(shortcut.to_string());
                                } else {
                                    log::warn!("Failed to store managed shortcut in memory");
                                }
                            }
                        }
                    }
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                local_http_api::flush_cache();
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_CONCURRENT_PROBES, probe_worker_count, read_plugin_config_file,
        write_plugin_config_file,
    };
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_config_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("openusage-config-{}-{}", label, nanos))
            .join("plugins_data")
            .join("x")
            .join("config.json")
    }

    #[test]
    fn plugin_config_round_trips_and_keeps_unknown_keys() {
        let path = temp_config_path("roundtrip");
        assert!(read_plugin_config_file(&path).unwrap().is_empty());

        let mut map = serde_json::Map::new();
        map.insert("aliases".to_string(), serde_json::json!({ "abc": "work" }));
        map.insert("baseUrl".to_string(), serde_json::json!("http://relay:8317"));
        write_plugin_config_file(&path, &map).unwrap();

        let read = read_plugin_config_file(&path).unwrap();
        assert_eq!(read.get("baseUrl"), Some(&serde_json::json!("http://relay:8317")));
        assert_eq!(read.get("aliases"), Some(&serde_json::json!({ "abc": "work" })));
        assert!(!path.with_extension("json.tmp").exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn plugin_config_rejects_non_object_json() {
        let path = temp_config_path("array");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "[1, 2]").unwrap();
        assert!(read_plugin_config_file(&path)
            .unwrap_err()
            .contains("not a JSON object"));
        std::fs::write(&path, "{not json").unwrap();
        assert!(read_plugin_config_file(&path)
            .unwrap_err()
            .contains("not valid JSON"));
    }

    #[test]
    fn probe_worker_count_is_bounded() {
        assert_eq!(probe_worker_count(0), 0);
        assert_eq!(probe_worker_count(1), 1);
        assert_eq!(
            probe_worker_count(MAX_CONCURRENT_PROBES),
            MAX_CONCURRENT_PROBES
        );
        assert_eq!(
            probe_worker_count(MAX_CONCURRENT_PROBES + 1),
            MAX_CONCURRENT_PROBES
        );
    }
}
