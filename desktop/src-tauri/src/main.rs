#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use swift_desktop_core::{gateway, storage::NativeVault};
use tauri::{
    webview::WebviewBuilder,
    window::{Color, WindowBuilder},
    Manager, WebviewUrl,
};
mod updates;

fn main() {
    // WebView2 reads this before its controller exists; setting only CSS is too late.
    #[cfg(target_os = "windows")]
    std::env::set_var("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF17171A");
    // Explicit development data directories also isolate single-instance and window state.
    let isolated = std::env::var_os("SWIFT_DESKTOP_DATA_DIR");
    let mut context = tauri::generate_context!();
    if let Some(directory) = &isolated {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        directory.hash(&mut hash);
        context.config_mut().identifier =
            format!("{}.test{:x}", context.config().identifier, hash.finish());
    }
    let port = if let Some(directory) = &isolated {
        std::fs::read_to_string(std::path::PathBuf::from(directory).join("development-port"))
            .ok()
            .and_then(|value| value.trim().parse::<u16>().ok())
            .unwrap_or(0)
    } else {
        gateway::DEFAULT_PORT
    };
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(runtime) = app.try_state::<gateway::Gateway>() {
                open_window(app.clone(), format!("{}/connect", runtime.origin));
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let directory = std::env::var_os("SWIFT_DESKTOP_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let vault: Arc<dyn swift_desktop_core::storage::Vault> = if isolated.is_some() {
                Arc::new(swift_desktop_core::storage::ScopedVault::new(
                    Arc::new(NativeVault),
                    &directory,
                ))
            } else {
                Arc::new(NativeVault)
            };
            let runtime = tauri::async_runtime::block_on(gateway::start(&directory, port, vault))?;
            if isolated.is_some() {
                let chosen = runtime
                    .origin
                    .strip_prefix("http://127.0.0.1:")
                    .ok_or("Unexpected development origin")?;
                chosen.parse::<u16>()?;
                std::fs::write(directory.join("development-port"), chosen)?;
            }
            runtime.set_updates(Arc::new(updates::Updates::new(app.handle().clone())));
            let start = runtime.bootstrap_url.clone();
            app.manage(WindowConfig {
                directory: directory.join("webview"),
                origin: runtime.origin.clone(),
            });
            app.manage(runtime);
            build_window(app.handle(), "main", start.parse()?)?;
            Ok(())
        })
        .build(context);
    let application = match application {
        Ok(application) => application,
        Err(error) => {
            show_startup_error(&error.to_string());
            return;
        }
    };
    application.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            app.state::<gateway::Gateway>().stop();
        }
    });
}
struct WindowConfig {
    directory: PathBuf,
    origin: String,
}
static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(1);
fn open_window(app: tauri::AppHandle, url: String) {
    // WebView2 creation must run outside synchronous window event callbacks.
    std::thread::spawn(move || {
        let label = format!("window-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
        let result = url
            .parse()
            .map_err(tauri::Error::InvalidUrl)
            .and_then(|url| build_window(&app, &label, url));
        if let Err(error) = result {
            show_startup_error(&error.to_string());
        }
    });
}
fn build_window(app: &tauri::AppHandle, label: &str, start: tauri::Url) -> tauri::Result<()> {
    let config = app.state::<WindowConfig>();
    let origin = config.origin.clone();
    let popup_origin = origin.clone();
    let popup_app = app.clone();
    // Restore native geometry before the first show. WebView2 initialization must
    // not delay the OS window or resize an already visible window afterwards.
    let window = WindowBuilder::new(app, label)
        .title("Swift")
        .inner_size(1280.0, 860.0)
        .min_inner_size(760.0, 540.0)
        .background_color(Color(23, 23, 26, 255))
        .visible(false)
        .build()?;
    window.show()?;
    let directory = config.directory.clone();
    let label = label.to_owned();
    let app = app.clone();
    std::thread::spawn(move || {
        let size = match window.inner_size() {
            Ok(size) => size,
            Err(_) => return,
        };
        let builder = WebviewBuilder::new(&label, WebviewUrl::External(start))
            .auto_resize()
            .background_color(Color(23, 23, 26, 255))
            .data_directory(directory)
            .disable_drag_drop_handler()
            .zoom_hotkeys_enabled(true)
            .additional_browser_args(concat!(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,msWindowsTaskManager",
                " --autoplay-policy=no-user-gesture-required"
            ))
            .on_document_title_changed(|webview, title| { let _ = webview.window().set_title(&title); })
            .on_navigation(move |url| {
                if url.origin().ascii_serialization() == origin { return true; }
                if ["http", "https"].contains(&url.scheme()) && url.username().is_empty() && url.password().is_none() {
                    let _ = open_external(url.as_str());
                }
                false
            })
            .on_new_window(move |url, _| {
                if url.origin().ascii_serialization() == popup_origin {
                    let path = url.path();
                    let connection = path.strip_prefix("/e/").and_then(|v| v.strip_suffix('/'));
                    if path == "/connect" || connection.is_some_and(swift_desktop_core::storage::valid_id) {
                        open_window(popup_app.clone(), url.to_string());
                    }
                } else if ["http", "https"].contains(&url.scheme()) && url.username().is_empty() && url.password().is_none() {
                    let _ = open_external(url.as_str());
                }
                tauri::webview::NewWindowResponse::Deny
            });
        // A close during initialization must not create a replacement window.
        if app.get_window(&label).is_none() {
            return;
        }
        if let Err(error) = window.add_child(builder, tauri::PhysicalPosition::new(0, 0), size) {
            if app.get_window(&label).is_some() {
                show_startup_error(&error.to_string());
                let _ = window.close();
            }
        }
    });
    Ok(())
}

#[cfg(target_os = "windows")]
fn show_startup_error(message: &str) {
    let title: Vec<u16> = "Swift 无法启动\0".encode_utf16().collect();
    let text: Vec<u16> = format!("{message}\0").encode_utf16().collect();
    // Initialization messages contain only configuration/OS errors, never credentials.
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            0x10,
        );
    }
}
#[cfg(not(target_os = "windows"))]
fn show_startup_error(message: &str) {
    eprintln!("Swift 无法启动：{message}");
}
fn open_external(url: &str) -> std::io::Result<()> {
    swift_desktop_core::gateway::open_external(url)
}
