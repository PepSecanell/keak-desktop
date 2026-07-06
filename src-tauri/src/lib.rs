use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

// Holds the user's clipboard while a Rewrite is in progress, so we can put it back afterward.
static CLIPBOARD_STASH: Mutex<Option<String>> = Mutex::new(None);

// Copies the current selection to a string by stashing the clipboard, sending Ctrl+C, and reading it
// back. Call this while the TARGET app still has focus (i.e. before showing the overlay).
fn copy_selection_to_string() -> String {
    let mut cb = match arboard::Clipboard::new() {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    // Stash whatever is on the clipboard now so restore_clipboard can return it.
    *CLIPBOARD_STASH.lock().unwrap() = cb.get_text().ok();
    if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
        let _ = enigo.key(Key::Control, Direction::Press);
        let _ = enigo.key(Key::Unicode('c'), Direction::Click);
        let _ = enigo.key(Key::Control, Direction::Release);
    }
    std::thread::sleep(std::time::Duration::from_millis(120));
    cb.get_text().unwrap_or_default()
}

#[tauri::command]
fn restore_clipboard() -> Result<(), String> {
    let stashed = CLIPBOARD_STASH.lock().unwrap().take();
    if let Some(text) = stashed {
        if let Ok(mut cb) = arboard::Clipboard::new() {
            let _ = cb.set_text(text);
        }
    }
    Ok(())
}

// Grabs the current selection AFTER the Win+Alt modifiers are released. We hide the overlay first and
// wait, so the target app has focus and the simulated Ctrl+C is clean (not Win+Alt+Ctrl+C). Then the
// overlay is shown again so the "Rewriting…" / error state stays visible.
#[tauri::command]
fn capture_selection(app: AppHandle) -> Result<String, String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
    std::thread::sleep(std::time::Duration::from_millis(250));
    let text = copy_selection_to_string();
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.show();
    }
    Ok(text)
}

// Screenshot the primary monitor for Keak AI "screen vision". The overlay is a small centered orb, so
// we DON'T hide it: hiding + reshowing made the panel visibly disappear and pop back (jarring). The tiny
// orb in the shot is harmless. Downscales + JPEG-encodes to keep the payload small, returns base64.
#[tauri::command]
fn capture_screen(_app: AppHandle) -> Result<String, String> {
    use base64::Engine;

    let result = (|| -> Result<String, String> {
        let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
        // Prefer the primary monitor (the one the user is most likely looking at); fall back to first.
        let monitor = monitors
            .iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .cloned()
            .or_else(|| monitors.into_iter().next())
            .ok_or_else(|| "no monitor found".to_string())?;
        let img = monitor.capture_image().map_err(|e| e.to_string())?; // image::RgbaImage
        let (w, h) = (img.width(), img.height());
        let dyn_img = image::DynamicImage::ImageRgba8(img);
        // Downscale to max 1280px wide so the upload stays small.
        let max_w = 1280u32;
        let scaled = if w > max_w {
            let nh = ((h as f32) * (max_w as f32 / w as f32)).round() as u32;
            dyn_img.resize(max_w, nh.max(1), image::imageops::FilterType::Triangle)
        } else {
            dyn_img
        };
        let rgb = scaled.to_rgb8();
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut cursor = std::io::Cursor::new(&mut buf);
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 70)
                .encode_image(&rgb)
                .map_err(|e| e.to_string())?;
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
    })();

    result
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn inject_text(app: AppHandle, text: String) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.text(&text).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        overlay.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_main(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // MUST be the first plugin registered. On Windows/Linux a keak:// deep link
    // launches a SECOND copy of the app; single-instance forwards it to the already
    // running instance (which holds the PKCE verifier + the oauth-callback listener).
    // The "deep-link" feature re-fires the deep_link().on_open_url handler below.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // Push-to-talk via a key-state watcher, so bare modifier combos work:
            //   Ctrl+Win = dictate, Ctrl+Alt = Thought Dump. Hold to record, release to insert.
            #[cfg(windows)]
            ptt_watch::install(app.handle().clone());

            // Register keak:// deep link scheme (needed in dev mode)
            #[cfg(desktop)]
            let _ = app.deep_link().register_all();

            // When OAuth callback fires, broadcast URL to all windows
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let _ = handle.emit("oauth-callback", url.to_string());
                    if let Some(main) = handle.get_webview_window("main") {
                        let _ = main.show();
                        let _ = main.set_focus();
                    }
                }
            });

            // Closing the Settings window should HIDE it, not destroy it — otherwise the tray "Settings"
            // item has no window to reopen and silently does nothing.
            if let Some(main) = app.get_webview_window("main") {
                let main_for_event = main.clone();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = main_for_event.hide();
                    }
                });
            }

            let quit_i = MenuItem::with_id(app, "quit", "Quit Keak", true, None::<&str>)?;
            let settings_i =
                MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Keak — Ctrl+K to dictate")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "settings" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_url, inject_text, hide_overlay, show_main, restore_clipboard, capture_selection, capture_screen])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Push-to-talk watcher. Bare modifier combos (Ctrl+Win, Ctrl+Alt) can't be registered as normal
// global shortcuts, so we poll key state ~30ms and drive the same ptt-start / ptt-stop events.
#[cfg(windows)]
mod ptt_watch {
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::OnceLock;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager};
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    // 0 = idle, 1 = dictate (Ctrl+Win), 2 = alt (Ctrl+Alt — JS routes to Keak AI or Thought Dump),
    // 3 = rewrite (Win+Alt — rewrite the current selection from a spoken instruction)
    static ACTIVE: AtomicU8 = AtomicU8::new(0);

    fn down(vk: i32) -> bool {
        (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
    }

    fn show_overlay(app: &AppHandle) {
        if let Some(overlay) = app.get_webview_window("overlay") {
            let _ = overlay.show();
        }
    }

    fn start_dictate() {
        ACTIVE.store(1, Ordering::SeqCst);
        if let Some(app) = APP.get() {
            show_overlay(app);
            let _ = app.emit("ptt-start", false); // dump=false (normal cleanup)
        }
    }

    fn start_alt() {
        ACTIVE.store(2, Ordering::SeqCst);
        if let Some(app) = APP.get() {
            show_overlay(app);
            let _ = app.emit("alt-start", ()); // overlay decides Keak AI vs Thought Dump
        }
    }

    fn start_rewrite() {
        ACTIVE.store(3, Ordering::SeqCst);
        // Don't copy the selection yet — the modifiers are still held, which would corrupt Ctrl+C.
        // The overlay grabs the instruction; the selection is captured on release (capture_selection).
        if let Some(app) = APP.get() {
            show_overlay(app);
            let _ = app.emit("rewrite-start", ());
        }
    }

    fn emit_stop(event: &'static str) {
        ACTIVE.store(0, Ordering::SeqCst);
        if let Some(app) = APP.get() {
            let _ = app.emit(event, ());
        }
    }

    pub fn install(app: AppHandle) {
        let _ = APP.set(app);
        std::thread::spawn(|| loop {
            let ctrl = down(0x11); // VK_CONTROL (either side)
            let win = down(0x5B) || down(0x5C); // VK_LWIN / VK_RWIN
            let lalt = down(0xA4); // VK_LMENU only, so AltGr (right Alt) never triggers this
            // Mutually exclusive so the three combos never overlap:
            let ctrl_win = ctrl && win && !lalt; // Dictate
            let ctrl_alt = ctrl && lalt && !win; // Thought Dump / Keak AI
            let win_alt = win && lalt && !ctrl; // Rewrite selection

            match ACTIVE.load(Ordering::SeqCst) {
                0 => {
                    if ctrl_win {
                        start_dictate();
                    } else if ctrl_alt {
                        start_alt();
                    } else if win_alt {
                        start_rewrite();
                    }
                }
                1 => {
                    if !ctrl_win {
                        emit_stop("ptt-stop");
                    }
                }
                2 => {
                    if !ctrl_alt {
                        emit_stop("alt-stop");
                    }
                }
                3 => {
                    if !win_alt {
                        emit_stop("rewrite-stop");
                    }
                }
                _ => {}
            }
            std::thread::sleep(Duration::from_millis(30));
        });
    }
}
