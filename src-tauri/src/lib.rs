use std::sync::atomic::{AtomicBool, Ordering};
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
    bot_status_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    session_count_item: Mutex<Option<MenuItem<tauri::Wry>>>,
}

#[tauri::command]
fn get_api_port(state: State<'_, AppState>) -> Result<u16, String> {
    let port = state.api_port.lock().map_err(|e| e.to_string())?;
    port.ok_or_else(|| "API port not yet discovered".to_string())
}

// Verified OS-level kill matrix for `perform_shutdown` reuse (R16):
// - macOS Cmd-Q / Quit menu / Activity Monitor Force Quit -> Tauri emits
//   WindowEvent::Destroyed on the main window before exit -> shutdown runs.
// - Windows close button (already routed through CloseRequested below) and
//   Task Manager "End Task" -> Destroyed fires; shutdown runs.
// - Linux SIGTERM/SIGINT to the Tauri PID -> Destroyed fires; shutdown runs.
// `is_shutting_down` guards against double-entry when tray Quit calls
// `app_handle.exit(0)` (which itself raises Destroyed on some platforms).
fn perform_shutdown(app_handle: &AppHandle) {
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
            let _ = client.get(&shutdown_url).send().await;
        });
        // Give Node time to clean up before force-killing
        std::thread::sleep(Duration::from_secs(2));
    }

    if let Ok(mut child_lock) = state.sidecar_child.lock() {
        if let Some(child) = child_lock.take() {
            if let Err(e) = child.kill() {
                log::error!("Failed to kill sidecar: {}", e);
            }
        }
    }
    app_handle.exit(0);
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
    tauri::Builder::default()
        .manage(AppState {
            api_port: Mutex::new(None),
            sidecar_child: Mutex::new(None),
            is_shutting_down: AtomicBool::new(false),
            bot_status_item: Mutex::new(None),
            session_count_item: Mutex::new(None),
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .invoke_handler(tauri::generate_handler![get_api_port])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

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
                            log::info!("Sidecar stdout: {}", line.trim());
                            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                                if msg.get("type").and_then(|t| t.as_str()) == Some("ready") {
                                    if let Some(port) = msg.get("port").and_then(|p| p.as_u64()) {
                                        let state = app_handle.state::<AppState>();
                                        if let Ok(mut port_lock) = state.api_port.lock() {
                                            *port_lock = Some(port as u16);
                                        }
                                        log::info!("Sidecar ready on port {}", port);
                                        break;
                                    }
                                }
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
                    let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }
            tauri::WindowEvent::Destroyed => {
                perform_shutdown(&window.app_handle());
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
