use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

const TRAY_POLL_INTERVAL: Duration = Duration::from_secs(5);

struct AppState {
    api_port: Mutex<Option<u16>>,
    sidecar_child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
    is_shutting_down: AtomicBool,
    is_updating: AtomicBool,
    bot_status_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    session_count_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    badge_count: AtomicU32,
}

#[tauri::command]
fn get_api_port(state: State<'_, AppState>) -> Result<u16, String> {
    let port = state.api_port.lock().map_err(|e| e.to_string())?;
    port.ok_or_else(|| "API port not yet discovered".to_string())
}

#[tauri::command]
fn prepare_updater_relaunch(state: State<'_, AppState>) {
    state.is_updating.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn update_badge_state(app_handle: AppHandle, count: u32) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    state.badge_count.store(count, Ordering::SeqCst);

    #[cfg(target_os = "macos")]
    {
        if let Some(window) = app_handle.get_webview_window("main") {
            let badge = if count > 0 { Some(count as i64) } else { None };
            window
                .set_badge_count(badge)
                .map_err(|e| format!("Failed to set badge count: {}", e))?;

            let is_visible = window.is_visible().unwrap_or(true);
            if !is_visible {
                let policy = if count > 0 {
                    tauri::ActivationPolicy::Regular
                } else {
                    tauri::ActivationPolicy::Accessory
                };
                let _ = app_handle.set_activation_policy(policy);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(window) = app_handle.get_webview_window("main") {
            let attention_type = if count > 0 {
                Some(tauri::UserAttentionType::Informational)
            } else {
                None
            };
            let _ = window.request_user_attention(attention_type);
        }
    }

    Ok(())
}

#[tauri::command]
fn reveal_in_file_manager(path: String, _item_type: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to reveal file: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        if _item_type == "file" {
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", &path))
                .spawn()
                .map_err(|e| format!("Failed to reveal file: {}", e))?;
        } else {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| format!("Failed to reveal folder: {}", e))?;
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to reveal file: {}", e))?;
    }

    Ok(())
}

// Verified OS-level kill matrix for `perform_shutdown` reuse (R16):
// - macOS Cmd-Q / Quit menu / Activity Monitor Force Quit -> Tauri emits
//   WindowEvent::Destroyed on the main window before exit -> shutdown runs.
// - Windows close button (already routed through CloseRequested below) and
//   Task Manager "End Task" -> Destroyed fires; shutdown runs.
// - Linux SIGTERM/SIGINT to the Tauri PID -> Destroyed fires; shutdown runs.
// `is_shutting_down` guards against double-entry when multiple quit events
// fire in quick succession (e.g. tray Quit calls `app_handle.exit(0)`, which
// raises both `WindowEvent::Destroyed` and `RunEvent::Exit`).
fn cleanup_sidecar(app_handle: &AppHandle, grace_period: Duration) {
    let state = app_handle.state::<AppState>();
    if state
        .is_shutting_down
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    // Request graceful shutdown from the Node sidecar before force-killing
    let port_opt = {
        let state = app_handle.state::<AppState>();
        state.api_port.lock().ok().and_then(|guard| *guard)
    };
    if let Some(port) = port_opt {
        let shutdown_url = format!("http://127.0.0.1:{}/shutdown", port);
        tauri::async_runtime::spawn(async move {
            let client = match reqwest::Client::builder()
                .timeout(Duration::from_secs(1))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    log::error!("Failed to build shutdown HTTP client: {}", e);
                    return;
                }
            };
            let _ = client.post(&shutdown_url).send().await;
        });
        // Give Node time to clean up before force-killing
        std::thread::sleep(grace_period);
    }

    let child_opt = state
        .sidecar_child
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());

    if let Some(child) = child_opt {
        if let Err(e) = child.kill() {
            log::error!("Failed to kill sidecar: {}", e);
        }
    }
}

fn perform_shutdown(app_handle: &AppHandle) {
    cleanup_sidecar(app_handle, Duration::from_secs(2));
    app_handle.exit(0);
}

fn cleanup_before_exit(app_handle: &AppHandle) {
    let state = app_handle.state::<AppState>();
    let grace = if state.is_updating.load(Ordering::SeqCst) {
        Duration::from_secs(5)
    } else {
        Duration::from_millis(500)
    };
    cleanup_sidecar(app_handle, grace);
}

fn show_main_window(app_handle: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[derive(Deserialize)]
struct TrayStatusResponse {
    #[serde(rename = "wecomBot")]
    wecom_bot: String,
    #[serde(rename = "activeSessions")]
    active_sessions: u64,
}

fn bot_status_label(state: &str) -> String {
    match state {
        "connected" => "WeCom bot: connected".to_string(),
        "partial" => "WeCom bot: partially connected".to_string(),
        "disconnected" => "WeCom bot: disconnected".to_string(),
        _ => "WeCom bot: not configured".to_string(),
    }
}

async fn run_tray_status_poller(app_handle: AppHandle) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::error!("Failed to build tray status HTTP client: {}", e);
            return;
        }
    };

    loop {
        {
            let state = app_handle.state::<AppState>();
            if state.is_shutting_down.load(Ordering::SeqCst) {
                break;
            }
        }

        let port_opt = {
            let state = app_handle.state::<AppState>();
            state.api_port.lock().ok().and_then(|guard| *guard)
        };

        if let Some(port) = port_opt {
            let url = format!("http://127.0.0.1:{}/api/system/tray-status", port);
            match client.get(&url).send().await {
                Ok(resp) => match resp.json::<TrayStatusResponse>().await {
                    Ok(body) => {
                        let bot_text = bot_status_label(&body.wecom_bot);
                        let session_text = format!("Active sessions: {}", body.active_sessions);
                        let state = app_handle.state::<AppState>();
                        if let Ok(guard) = state.bot_status_item.lock() {
                            if let Some(item) = guard.as_ref() {
                                let _ = item.set_text(&bot_text);
                            }
                        }
                        if let Ok(guard) = state.session_count_item.lock() {
                            if let Some(item) = guard.as_ref() {
                                let _ = item.set_text(&session_text);
                            }
                        };
                    }
                    Err(e) => log::debug!("Tray status parse failed: {}", e),
                },
                Err(e) => log::debug!("Tray status fetch failed: {}", e),
            }
        }

        tokio::time::sleep(TRAY_POLL_INTERVAL).await;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .manage(AppState {
            api_port: Mutex::new(None),
            sidecar_child: Mutex::new(None),
            is_shutting_down: AtomicBool::new(false),
            is_updating: AtomicBool::new(false),
            bot_status_item: Mutex::new(None),
            session_count_item: Mutex::new(None),
            badge_count: AtomicU32::new(0),
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .invoke_handler(tauri::generate_handler![
            get_api_port,
            prepare_updater_relaunch,
            update_badge_state,
            reveal_in_file_manager
        ])
        .setup(|app| {
            // Persistent file logging for both debug and release builds. In a
            // packaged release this is the only place Rust-shell diagnostics land
            // (Windows release has no console), so the logger installs
            // unconditionally rather than debug-only.
            //
            // The file target lives in the app-data `logs/` folder — the same
            // directory the Node sidecar writes to (the shell passes app_data_dir
            // as COMATE_DATA_DIR) — so Rust and Node logs co-locate, and the
            // Node-side folder cleanup bounds both.
            let mut targets: Vec<tauri_plugin_log::Target> = if cfg!(debug_assertions) {
                vec![tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                )]
            } else {
                Vec::new()
            };

            // Resolve the logs directory; if it is unavailable or cannot be
            // created, omit the file target and degrade silently rather than
            // aborting startup.
            let file_target = app
                .path()
                .app_data_dir()
                .ok()
                .map(|dir| dir.join("logs"))
                .and_then(|logs_dir| std::fs::create_dir_all(&logs_dir).ok().map(|_| logs_dir))
                .map(|logs_dir| {
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                        path: logs_dir,
                        file_name: Some("main".to_string()),
                    })
                });
            if let Some(target) = file_target {
                targets.push(target);
            }

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                    .level(log::LevelFilter::Info)
                    .targets(targets)
                    // Best-effort in-process bounding (max_file_size is not always
                    // enforced — tauri-apps/plugins-workspace#707). The Node-side
                    // folder cleanup is the authoritative bound. KeepOne avoids the
                    // KeepAll rotation bug (#1397).
                    .max_file_size(5 * 1024 * 1024)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                    .build(),
            )?;

            // Build the tray menu. The two status items are disabled — they
            // render as read-only labels and the poller updates their text.
            let open_item = MenuItemBuilder::with_id("open", "Open Comate")
                .enabled(true)
                .build(app)?;
            let bot_item = MenuItemBuilder::with_id("bot_status", "WeCom bot: …")
                .enabled(false)
                .build(app)?;
            let session_item = MenuItemBuilder::with_id("session_count", "Active sessions: …")
                .enabled(false)
                .build(app)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit Comate")
                .enabled(true)
                .build(app)?;

            let tray_menu = MenuBuilder::new(app)
                .item(&open_item)
                .item(&bot_item)
                .item(&session_item)
                .item(&separator)
                .item(&quit_item)
                .build()?;

            {
                let state = app.state::<AppState>();
                if let Ok(mut guard) = state.bot_status_item.lock() {
                    *guard = Some(bot_item);
                }
                if let Ok(mut guard) = state.session_count_item.lock() {
                    *guard = Some(session_item);
                };
            }

            let tray_builder = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
                    tauri::image::Image::new(&[], 0, 0)
                }))
                .menu(&tray_menu)
                .show_menu_on_left_click(cfg!(target_os = "macos"))
                .on_menu_event(|app_handle, event| match event.id().as_ref() {
                    "open" => show_main_window(app_handle),
                    "quit" => perform_shutdown(app_handle),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if cfg!(target_os = "macos") {
                        return;
                    }
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            if let Err(e) = tray_builder.build(app) {
                // On Linux desktops without a status notifier host, tray
                // creation fails. Window close-to-hide still works; the user
                // loses the tray entry but the app remains functional.
                log::error!("Failed to build system tray: {}", e);
            }

            let app_handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                let shell = app_handle.shell();
                let sidecar_command = match shell.sidecar("sidecar-node") {
                    Ok(cmd) => cmd,
                    Err(e) => {
                        log::error!("Failed to create sidecar command: {}", e);
                        return;
                    }
                };

                let data_dir = match app_handle.path().app_data_dir() {
                    Ok(dir) => dir,
                    Err(e) => {
                        log::error!("Failed to get app data dir: {}", e);
                        return;
                    }
                };

                let resource_dir = match app_handle.path().resource_dir() {
                    Ok(dir) => dir,
                    Err(e) => {
                        log::error!("Failed to get resource dir: {}", e);
                        return;
                    }
                };

                if let Err(e) = std::fs::create_dir_all(&data_dir) {
                    log::error!("Failed to create data dir: {}", e);
                    return;
                }

                let sidecar_command = sidecar_command
                    .env("COMATE_DATA_DIR", &data_dir)
                    .env("TAURI_RESOURCE_DIR", &resource_dir)
                    .env("PORT", "0")
                    .env("COMATE_SIDECAR", "1");

                let (mut rx, child) = match sidecar_command.spawn() {
                    Ok((rx, child)) => (rx, child),
                    Err(e) => {
                        log::error!("Failed to spawn sidecar: {}", e);
                        return;
                    }
                };

                {
                    let state = app_handle.state::<AppState>();
                    if let Ok(mut child_lock) = state.sidecar_child.lock() {
                        *child_lock = Some(child);
                    };
                }

                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let line = String::from_utf8_lossy(&line);
                            let trimmed = line.trim();
                            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                                if msg.get("type").and_then(|t| t.as_str()) == Some("ready") {
                                    if let Some(port) = msg.get("port").and_then(|p| p.as_u64()) {
                                        let state = app_handle.state::<AppState>();
                                        if let Ok(mut port_lock) = state.api_port.lock() {
                                            *port_lock = Some(port as u16);
                                        }
                                        log::info!("Sidecar ready on port {}", port);
                                        continue;
                                    }
                                }
                            }
                            if cfg!(debug_assertions) {
                                log::info!("Sidecar stdout: {}", trimmed);
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            let line = String::from_utf8_lossy(&line);
                            log::error!("Sidecar stderr: {}", line.trim());
                        }
                        CommandEvent::Error(e) => {
                            log::error!("Sidecar error: {}", e);
                            break;
                        }
                        CommandEvent::Terminated(payload) => {
                            log::info!(
                                "Sidecar terminated: code={:?}, signal={:?}",
                                payload.code,
                                payload.signal
                            );
                            break;
                        }
                        _ => {}
                    }
                }
            });

            let poller_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                run_tray_status_poller(poller_handle).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let app_handle = window.app_handle();
                if app_handle
                    .state::<AppState>()
                    .is_shutting_down
                    .load(Ordering::SeqCst)
                {
                    return;
                }
                let _ = window.hide();
                #[cfg(target_os = "macos")]
                {
                    let state = app_handle.state::<AppState>();
                    let badge_count = state.badge_count.load(Ordering::SeqCst);
                    if badge_count == 0 {
                        let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                }
            }
            tauri::WindowEvent::Destroyed => {
                perform_shutdown(&window.app_handle());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::Exit => {
                cleanup_before_exit(app_handle);
            }
            tauri::RunEvent::ExitRequested { .. } => {
                cleanup_before_exit(app_handle);
            }
            _ => {}
        });
}
