use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

struct AppState {
    api_port: Mutex<Option<u16>>,
    sidecar_child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

#[tauri::command]
fn get_api_port(state: State<'_, AppState>) -> Result<u16, String> {
    let port = state.api_port.lock().map_err(|e| e.to_string())?;
    port.ok_or_else(|| "API port not yet discovered".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            api_port: Mutex::new(None),
            sidecar_child: Mutex::new(None),
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_api_port])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
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
                    .env("CLAUDE_CODE_GUI_DATA_DIR", &data_dir)
                    .env("TAURI_RESOURCE_DIR", &resource_dir)
                    .env("PORT", "0")
                    .env("CLAUDE_CODE_GUI_SIDECAR", "1");

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

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app_handle = window.app_handle();
                let state = app_handle.state::<AppState>();
                if let Ok(mut child_lock) = state.sidecar_child.lock() {
                    if let Some(child) = child_lock.take() {
                        if let Err(e) = child.kill() {
                            log::error!("Failed to kill sidecar: {}", e);
                        }
                    }
                }
                app_handle.exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
