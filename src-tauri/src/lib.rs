use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

// Shared sender so Tauri commands can push browser commands to the connected extension.
static BROWSER_TX: Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>> = Mutex::new(None);

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

// Send a browser command (JSON string) to the Chrome extension via WebSocket.
// Called from the overlay JS when Keak AI returns a browser_action.
#[tauri::command]
fn send_browser_command(command: String) -> Result<(), String> {
    let tx = BROWSER_TX.lock().unwrap();
    if let Some(sender) = tx.as_ref() {
        sender.send(command).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Chrome extension not connected".into())
    }
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

// Keak Streaming (at-cursor): type a small delta live as you speak, WITHOUT hiding the overlay pill or the
// settle delay, so words appear at your cursor in real time. The pill never has focus, so this lands in the
// text field you're typing in (same as normal dictation inject).
#[tauri::command]
fn stream_type(text: String) -> Result<(), String> {
    if text.is_empty() { return Ok(()); }
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.text(&text).map_err(|e| e.to_string())?;
    Ok(())
}

// On release, swap the raw live-typed text for the final clean version: backspace `back` characters, then
// type the well-written `add`. This is the one place backspaces are sent, right when the key is released.
#[tauri::command]
fn stream_replace(app: AppHandle, back: usize, add: String) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") { let _ = overlay.hide(); }
    std::thread::sleep(std::time::Duration::from_millis(120));
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    for _ in 0..back { let _ = enigo.key(Key::Backspace, Direction::Click); }
    if !add.is_empty() { enigo.text(&add).map_err(|e| e.to_string())?; }
    Ok(())
}

// ---- Native computer-use primitives ("TARS": Keak can touch anything on the whole screen) ----
// These move the real OS cursor / keyboard, so they work in ANY app, not just the browser. The
// frontend agent loop screenshots (capture_screen_full), asks a vision model for the next action,
// then calls these to carry it out. Coordinates are REAL virtual-desktop pixels; the caller maps
// the model's coordinates from the (downscaled) screenshot back to full resolution first.

// Screenshot the primary monitor at full resolution and report the real pixel size + origin, so the
// frontend can translate model coordinates (given against the downscaled JPEG) to true screen pixels.
// Returns a small JSON string: {"b64":..,"shot_w":..,"shot_h":..,"real_w":..,"real_h":..,"off_x":..,"off_y":..}
#[tauri::command]
fn capture_screen_full(_app: AppHandle) -> Result<String, String> {
    use base64::Engine;
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .cloned()
        .or_else(|| monitors.into_iter().next())
        .ok_or_else(|| "no monitor found".to_string())?;
    let off_x = monitor.x().unwrap_or(0);
    let off_y = monitor.y().unwrap_or(0);
    let img = monitor.capture_image().map_err(|e| e.to_string())?;
    let (real_w, real_h) = (img.width(), img.height());
    let dyn_img = image::DynamicImage::ImageRgba8(img);
    // Downscale the image sent to the model (keeps upload small); keep real_w/real_h for mapping.
    let max_w = 1366u32;
    let scaled = if real_w > max_w {
        let nh = ((real_h as f32) * (max_w as f32 / real_w as f32)).round() as u32;
        dyn_img.resize(max_w, nh.max(1), image::imageops::FilterType::Triangle)
    } else {
        dyn_img
    };
    let (shot_w, shot_h) = (scaled.width(), scaled.height());
    let rgb = scaled.to_rgb8();
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut buf);
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 72)
            .encode_image(&rgb)
            .map_err(|e| e.to_string())?;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    // base64 contains only [A-Za-z0-9+/=], so it is safe to inline inside a JSON string literal.
    Ok(format!(
        "{{\"b64\":\"{}\",\"shot_w\":{},\"shot_h\":{},\"real_w\":{},\"real_h\":{},\"off_x\":{},\"off_y\":{}}}",
        b64, shot_w, shot_h, real_w, real_h, off_x, off_y
    ))
}

// Move the cursor to an absolute screen pixel and click (left/right/middle, optional double-click).
#[tauri::command]
fn mouse_click(app: AppHandle, x: i32, y: i32, button: Option<String>, double: Option<bool>) -> Result<(), String> {
    use enigo::{Button, Coordinate, Mouse};
    // Never let the click land on our own overlay orb — get it out of the way first.
    if let Some(overlay) = app.get_webview_window("overlay") { let _ = overlay.hide(); }
    std::thread::sleep(std::time::Duration::from_millis(120));
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.move_mouse(x, y, Coordinate::Abs).map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(60));
    let btn = match button.as_deref() {
        Some("right") => Button::Right,
        Some("middle") => Button::Middle,
        _ => Button::Left,
    };
    enigo.button(btn, Direction::Click).map_err(|e| e.to_string())?;
    if double.unwrap_or(false) {
        std::thread::sleep(std::time::Duration::from_millis(70));
        enigo.button(btn, Direction::Click).map_err(|e| e.to_string())?;
    }
    if let Some(overlay) = app.get_webview_window("overlay") { let _ = overlay.show(); }
    Ok(())
}

// Move the cursor without clicking (used to show the user where Keak is about to act).
#[tauri::command]
fn mouse_move(x: i32, y: i32) -> Result<(), String> {
    use enigo::{Coordinate, Mouse};
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.move_mouse(x, y, Coordinate::Abs).map_err(|e| e.to_string())?;
    Ok(())
}

// Current cursor position in screen pixels — used by the agents overlay's "follow my mouse" mode.
#[tauri::command]
fn cursor_pos() -> Result<(i32, i32), String> {
    use enigo::Mouse;
    let enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.location().map_err(|e| e.to_string())
}

// Type text at the current focus (native — works in any app, not only the browser).
#[tauri::command]
fn type_text(text: String) -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.text(&text).map_err(|e| e.to_string())?;
    Ok(())
}

// Scroll the wheel: positive = down, negative = up.
#[tauri::command]
fn mouse_scroll(amount: i32) -> Result<(), String> {
    use enigo::{Axis, Mouse};
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.scroll(amount, Axis::Vertical).map_err(|e| e.to_string())?;
    Ok(())
}

// Press a single key or a chord like "ctrl+enter", "win+s", "enter", "tab", "escape".
#[tauri::command]
fn press_key(combo: String) -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let parts: Vec<String> = combo.to_lowercase().split('+').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() { return Ok(()); }
    let (mods, key_part) = parts.split_at(parts.len() - 1);
    let mut held: Vec<Key> = Vec::new();
    for m in mods {
        let k = match m.as_str() {
            "ctrl" | "control" => Key::Control,
            "alt" | "option" => Key::Alt,
            "shift" => Key::Shift,
            "win" | "cmd" | "meta" | "super" => Key::Meta,
            _ => continue,
        };
        enigo.key(k, Direction::Press).map_err(|e| e.to_string())?;
        held.push(k);
    }
    let kp = &key_part[0];
    let key = match kp.as_str() {
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        s if s.chars().count() == 1 => Key::Unicode(s.chars().next().unwrap()),
        _ => Key::Space,
    };
    let click_res = enigo.key(key, Direction::Click);
    // Always release held modifiers, even if the main key failed, so we don't leave Ctrl stuck down.
    for k in held.into_iter().rev() {
        let _ = enigo.key(k, Direction::Release);
    }
    click_res.map_err(|e| e.to_string())?;
    Ok(())
}

// ---- "Sign in with ChatGPT" (OpenAI device-authorization grant, the openai/codex flow) ----
// Lets the user connect their ChatGPT SUBSCRIPTION so Keak's screen agent runs with no per-call API
// cost. Constants verified from the openai/codex source (2026). Model calls later go to
// https://chatgpt.com/backend-api/codex/responses with Authorization: Bearer + ChatGPT-Account-ID.
const OPENAI_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_ISSUER: &str = "https://auth.openai.com";

// Pull the chatgpt_account_id out of the OAuth id_token (a JWT) without a JWT crate: base64url-decode
// the middle segment and read the claim (top-level or under the namespaced auth claim).
fn chatgpt_account_id_from_id_token(id_token: &str) -> String {
    use base64::Engine;
    let mut parts = id_token.split('.');
    let payload_b64 = match parts.nth(1) {
        Some(p) => p,
        None => return String::new(),
    };
    let bytes = match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload_b64) {
        Ok(b) => b,
        Err(_) => return String::new(),
    };
    let v: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    if let Some(id) = v.get("chatgpt_account_id").and_then(|x| x.as_str()) {
        return id.to_string();
    }
    if let Some(id) = v
        .get("https://api.openai.com/auth")
        .and_then(|a| a.get("chatgpt_account_id"))
        .and_then(|x| x.as_str())
    {
        return id.to_string();
    }
    String::new()
}

// Step 1: request a device + user code (the exact openai/codex device flow). The endpoint is under
// /api/accounts and wants a JSON body. Returns {user_code, device_auth_id, interval, verification_url}.
#[tauri::command]
async fn openai_login_start() -> Result<String, String> {
    use serde_json::json;
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}/api/accounts/deviceauth/usercode", OPENAI_ISSUER))
        .header("Content-Type", "application/json")
        .json(&json!({ "client_id": OPENAI_CLIENT_ID }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("usercode {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let user_code = v.get("user_code").or_else(|| v.get("usercode")).and_then(|x| x.as_str()).unwrap_or("");
    let device_auth_id = v.get("device_auth_id").and_then(|x| x.as_str()).unwrap_or("");
    let interval = v.get("interval").and_then(|x| x.as_u64()).unwrap_or(5);
    Ok(json!({
        "user_code": user_code,
        "device_auth_id": device_auth_id,
        "interval": interval,
        // The user opens this page and types the code.
        "verification_url": format!("{}/codex/device", OPENAI_ISSUER)
    })
    .to_string())
}

// Step 2: poll for authorization, then exchange for real tokens. While the user hasn't approved, the
// token endpoint returns 403/404 → {"ok":false,"pending":true}. On approval it returns an
// authorization_code + PKCE verifier, which we swap at /oauth/token for the access/id/refresh tokens.
#[tauri::command]
async fn openai_login_poll(device_auth_id: String, user_code: String) -> Result<String, String> {
    use serde_json::json;
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}/api/accounts/deviceauth/token", OPENAI_ISSUER))
        .header("Content-Type", "application/json")
        .json(&json!({ "device_auth_id": device_auth_id, "user_code": user_code }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::NOT_FOUND {
        return Ok(json!({ "ok": false, "pending": true }).to_string());
    }
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("devicetoken {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let authorization_code = v.get("authorization_code").and_then(|x| x.as_str()).unwrap_or("");
    let code_verifier = v.get("code_verifier").and_then(|x| x.as_str()).unwrap_or("");
    if authorization_code.is_empty() {
        return Ok(json!({ "ok": false, "pending": true }).to_string());
    }

    // Exchange the authorization code for tokens (.form() url-encodes + sets the right content type).
    let redirect_uri = format!("{}/deviceauth/callback", OPENAI_ISSUER);
    let tres = client
        .post(format!("{}/oauth/token", OPENAI_ISSUER))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", authorization_code),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", OPENAI_CLIENT_ID),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let tstatus = tres.status();
    let ttext = tres.text().await.map_err(|e| e.to_string())?;
    if !tstatus.is_success() {
        return Err(format!("token exchange {}: {}", tstatus.as_u16(), ttext.chars().take(200).collect::<String>()));
    }
    let tv: serde_json::Value = serde_json::from_str(&ttext).map_err(|e| e.to_string())?;
    let access = tv.get("access_token").and_then(|x| x.as_str()).unwrap_or("");
    let refresh = tv.get("refresh_token").and_then(|x| x.as_str()).unwrap_or("");
    let id_token = tv.get("id_token").and_then(|x| x.as_str()).unwrap_or("");
    let account = chatgpt_account_id_from_id_token(id_token);
    Ok(json!({ "ok": true, "access_token": access, "refresh_token": refresh, "account_id": account }).to_string())
}

// ---- Computer-use "brain": ask the connected provider for the NEXT screen action ----
// Plain vision-grounding (the model returns a JSON action), NOT the official computer-use tools, so it
// works over the ChatGPT subscription backend and over any API key. The overlay runs this in a loop.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CuArgs {
    provider: String,        // "openai" | "gemini" | "claude"
    credential: String,      // subscription access_token OR api key
    account_id: String,      // ChatGPT-Account-ID for the OpenAI subscription (else "")
    is_subscription: bool,
    model: String,           // optional override; "" = provider default
    goal: String,
    screenshot_b64: String,
    shot_w: u32,
    shot_h: u32,
    history: String,         // short summary of actions taken so far
    #[serde(default)]
    effort: String,          // Claude effort: "" | low | medium | high | max
}

const CU_SYSTEM: &str = "You control a computer to accomplish the user's goal. You are given a screenshot that is {W} pixels wide and {H} pixels tall. Decide the SINGLE next action and reply with ONLY a JSON object, no prose and no code fences. Schema: {\"action\":\"click|double_click|right_click|type|key|scroll|wait|done\",\"x\":<int>,\"y\":<int>,\"text\":\"<for type>\",\"key\":\"<e.g. enter, ctrl+a, escape>\",\"amount\":<int scroll amount, positive scrolls down>,\"say\":\"<one short present-tense sentence describing what you are doing>\"}. Coordinates are pixel positions inside the screenshot. Prefer clicking visible UI elements. When the goal is fully complete, return {\"action\":\"done\",\"say\":\"...\"}.";

// Pull the assistant's text out of a Responses API result (or a chat-completions fallback).
fn extract_output_text(v: &serde_json::Value) -> String {
    if let Some(s) = v.get("output_text").and_then(|x| x.as_str()) {
        return s.to_string();
    }
    if let Some(out) = v.get("output").and_then(|x| x.as_array()) {
        for item in out {
            if let Some(content) = item.get("content").and_then(|x| x.as_array()) {
                for c in content {
                    if let Some(t) = c.get("text").and_then(|x| x.as_str()) {
                        return t.to_string();
                    }
                }
            }
        }
    }
    if let Some(t) = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|x| x.as_str())
    {
        return t.to_string();
    }
    String::new()
}

// Extract the first balanced {...} JSON object from a string (the model was told to return pure JSON,
// but this survives stray prose or code fences).
fn extract_json_object(s: &str) -> Option<String> {
    let start = s.find('{')?;
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    for i in start..s.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(s[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

async fn openai_cu(args: &CuArgs) -> Result<String, String> {
    let (url, model) = if args.is_subscription {
        (
            "https://chatgpt.com/backend-api/codex/responses",
            if args.model.is_empty() { "gpt-5.6" } else { args.model.as_str() },
        )
    } else {
        (
            "https://api.openai.com/v1/responses",
            if args.model.is_empty() { "gpt-4o" } else { args.model.as_str() },
        )
    };
    let sys = CU_SYSTEM
        .replace("{W}", &args.shot_w.to_string())
        .replace("{H}", &args.shot_h.to_string());
    let hist = if args.history.is_empty() { "none" } else { args.history.as_str() };
    let user_text = format!("Goal: {}\nActions so far: {}", args.goal, hist);
    let body = serde_json::json!({
        "model": model,
        "instructions": sys,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": user_text},
                {"type": "input_image", "image_url": format!("data:image/jpeg;base64,{}", args.screenshot_b64)}
            ]
        }]
    });
    let client = reqwest::Client::new();
    let mut req = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", args.credential));
    if args.is_subscription {
        req = req
            .header("ChatGPT-Account-ID", args.account_id.as_str())
            .header("originator", "codex_cli_rs");
    }
    let res = req.json(&body).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("openai {}: {}", status.as_u16(), text.chars().take(300).collect::<String>()));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(extract_output_text(&v))
}

// Shared Anthropic Messages call with escalating 429 backoff. Subscription tokens throttle hard when used
// outside Claude's own apps (and agents fire several calls in a burst), so we retry a few times with growing
// waits and honor a Retry-After header when present. Returns the first text block.
async fn anthropic_send(body: &serde_json::Value, credential: &str, is_oauth: bool) -> Result<String, String> {
    let client = reqwest::Client::new();
    // Heavier models (Opus/Sonnet) on a subscription token throttle hard — give generous, growing waits and
    // honor Retry-After. A text chat can afford ~40s of retrying before giving up.
    let backoffs: [u64; 4] = [2000, 5000, 11000, 20000]; // ms between retries after the first attempt
    for attempt in 0..=backoffs.len() {
        let mut req = client
            .post("https://api.anthropic.com/v1/messages")
            .header("content-type", "application/json")
            .header("anthropic-version", "2023-06-01");
        req = if is_oauth {
            req.header("authorization", format!("Bearer {}", credential))
                .header("anthropic-beta", "oauth-2025-04-20")
        } else {
            req.header("x-api-key", credential)
        };
        let res = req.json(body).send().await.map_err(|e| e.to_string())?;
        let status = res.status();
        let retry_after = res
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());
        let text = res.text().await.map_err(|e| e.to_string())?;
        if status.as_u16() == 429 {
            if attempt < backoffs.len() {
                let wait = retry_after.map(|s| (s * 1000).min(20000)).unwrap_or(backoffs[attempt]);
                tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
                continue;
            }
            // Final 429 — return a clean, human message instead of the raw rate_limit JSON.
            return Err("Claude is rate-limiting your subscription right now (heavy models like Opus and Sonnet hit this fast). Wait a minute, switch this chat to Haiku, or paste an Anthropic API key in Connect for much higher limits.".into());
        }
        if !status.is_success() {
            // Surface the REAL reason (bad key, expired token, unknown model, etc.) instead of hiding it.
            let reason = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()).map(|s| s.to_string()))
                .unwrap_or_else(|| text.chars().take(180).collect::<String>());
            let hint = if status.as_u16() == 401 {
                " Your Claude token or API key is wrong or expired. If you used a subscription token, run `claude setup-token` again and paste the new one."
            } else if status.as_u16() == 404 {
                " That model isn't available on your account. Pick a different Claude model in Connect."
            } else { "" };
            return Err(format!("Claude error {}: {}{}", status.as_u16(), reason, hint));
        }
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        return Ok(v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.iter().find_map(|b| b.get("text").and_then(|t| t.as_str())))
            .unwrap_or("")
            .to_string());
    }
    Err("Claude is rate-limiting your subscription right now (this happens with Opus/Sonnet). Try again in a minute, switch this chat to Haiku, or paste an Anthropic API key in Connect for higher limits.".into())
}

// Adds the effort control when the chosen model supports it (Haiku and older Sonnets reject it).
fn add_effort(body: &mut serde_json::Value, model: &str, effort: &str) {
    if !effort.is_empty() && !model.contains("haiku") {
        body["output_config"] = serde_json::json!({ "effort": effort });
    }
}

// Validate a Claude token/key at CONNECT time with a tiny Haiku request (no effort, no big max_tokens, so the
// test only checks auth). Catches a wrong/expired token or a plan without API access up front, and returns the
// real reason, instead of silently "connecting" and then failing whenever Claude is actually used.
#[derive(serde::Deserialize)]
struct ClaudeVerifyArgs { credential: String }
#[tauri::command]
async fn claude_verify(args: ClaudeVerifyArgs) -> Result<String, String> {
    let cred = args.credential.trim();
    if cred.is_empty() { return Err("Paste your Claude token or API key first.".into()); }
    let is_oauth = cred.starts_with("sk-ant-oat");
    let body = serde_json::json!({
        "model": "claude-haiku-4-5",
        "max_tokens": 8,
        "messages": [{ "role": "user", "content": "hi" }]
    });
    anthropic_send(&body, cred, is_oauth).await.map(|_| "ok".to_string())
}

async fn claude_cu(args: &CuArgs) -> Result<String, String> {
    let model = if args.model.is_empty() { "claude-sonnet-4-6" } else { args.model.as_str() };
    let sys = CU_SYSTEM
        .replace("{W}", &args.shot_w.to_string())
        .replace("{H}", &args.shot_h.to_string());
    let hist = if args.history.is_empty() { "none" } else { args.history.as_str() };
    let user_text = format!("Goal: {}\nActions so far: {}", args.goal, hist);
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "system": sys,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": args.screenshot_b64}}
            ]
        }]
    });
    add_effort(&mut body, model, &args.effort);
    let is_oauth = args.credential.starts_with("sk-ant-oat") || args.is_subscription;
    anthropic_send(&body, &args.credential, is_oauth).await
}

// Local model via Ollama (OpenAI-compatible endpoint, no key). Screen control needs a VISION model
// (e.g. llama3.2-vision, qwen2-vl); a text-only model will just fail to place clicks.
async fn ollama_cu(args: &CuArgs) -> Result<String, String> {
    let model = if args.model.is_empty() { "llama3.2-vision" } else { args.model.as_str() };
    let sys = CU_SYSTEM
        .replace("{W}", &args.shot_w.to_string())
        .replace("{H}", &args.shot_h.to_string());
    let hist = if args.history.is_empty() { "none" } else { args.history.as_str() };
    let user_text = format!("Goal: {}\nActions so far: {}", args.goal, hist);
    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": sys },
            { "role": "user", "content": [
                { "type": "text", "text": user_text },
                { "type": "image_url", "image_url": { "url": format!("data:image/jpeg;base64,{}", args.screenshot_b64) } }
            ]}
        ]
    });
    let client = reqwest::Client::new();
    let res = client
        .post("http://localhost:11434/v1/chat/completions")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama isn't reachable ({}). Start it and pull a vision model.", e))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("ollama {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message")).and_then(|m| m.get("content")).and_then(|x| x.as_str()).unwrap_or("").to_string())
}

#[tauri::command]
async fn cu_step(args: CuArgs) -> Result<String, String> {
    let raw = match args.provider.as_str() {
        "openai" => openai_cu(&args).await?,
        "claude" => claude_cu(&args).await?,
        "ollama" => ollama_cu(&args).await?,
        other => return Err(format!("provider '{}' isn't wired for screen control yet", other)),
    };
    extract_json_object(&raw)
        .ok_or_else(|| format!("no JSON action in reply: {}", raw.chars().take(200).collect::<String>()))
}

// ---- Keak AI answers on the user's OWN connected AI (so it costs Pep nothing) ----
// Plain conversational chat (no screenshot). Same providers as cu_step; returns the spoken answer text.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatArgs {
    provider: String,
    credential: String,
    account_id: String,
    is_subscription: bool,
    model: String,
    system: String,
    history: Vec<ChatTurn>,
    message: String,
    #[serde(default)]
    effort: String,
}
#[derive(serde::Deserialize, Clone)]
struct ChatTurn {
    role: String,
    content: String,
}

async fn openai_chat(a: &ChatArgs) -> Result<String, String> {
    let (url, model) = if a.is_subscription {
        // A ChatGPT subscription talks to the Codex backend, which only accepts the Codex model set
        // (gpt-4o / gpt-5.6 etc. are rejected with "not supported when using Codex with a ChatGPT account").
        // Whitelist the known-good models; anything else falls back to gpt-5-codex (the Codex CLI default).
        const CODEX_OK: [&str; 5] = ["gpt-5", "gpt-5-codex", "codex-mini-latest", "o3", "o4-mini"];
        let m = if !a.model.is_empty() && CODEX_OK.contains(&a.model.as_str()) { a.model.as_str() } else { "gpt-5" };
        ("https://chatgpt.com/backend-api/codex/responses".to_string(), m)
    } else {
        ("https://api.openai.com/v1/responses".to_string(),
         if a.model.is_empty() { "gpt-4o" } else { a.model.as_str() })
    };
    let mut input: Vec<serde_json::Value> = a
        .history
        .iter()
        .map(|t| serde_json::json!({ "role": t.role, "content": t.content }))
        .collect();
    input.push(serde_json::json!({ "role": "user", "content": a.message }));
    let body = serde_json::json!({ "model": model, "instructions": a.system, "input": input, "max_output_tokens": 8192 });
    let client = reqwest::Client::new();
    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", a.credential));
    if a.is_subscription {
        req = req
            .header("ChatGPT-Account-ID", a.account_id.as_str())
            .header("originator", "codex_cli_rs");
    }
    let res = req.json(&body).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // A free ChatGPT plan gets a valid sign-in token but no Codex model access, so every model 400s with
        // "not supported". Give an actionable message instead of the raw error.
        if a.is_subscription && text.contains("not supported") {
            return Err("Your ChatGPT plan doesn't include Codex model access, so sign-in can't power Keak. Paste an OpenAI API key instead (Get an API key), or use Claude or Gemini.".to_string());
        }
        return Err(format!("openai {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(extract_output_text(&v))
}

async fn claude_chat(a: &ChatArgs) -> Result<String, String> {
    let model = if a.model.is_empty() { "claude-sonnet-4-6" } else { a.model.as_str() };
    let mut messages: Vec<serde_json::Value> = a
        .history
        .iter()
        .map(|t| serde_json::json!({ "role": if t.role == "assistant" { "assistant" } else { "user" }, "content": t.content }))
        .collect();
    messages.push(serde_json::json!({ "role": "user", "content": a.message }));
    // 8192 so the chat agent can emit a full HTML/doc artifact in one reply without truncating (1024 cut files off).
    let mut body = serde_json::json!({ "model": model, "max_tokens": 8192, "system": a.system, "messages": messages });
    add_effort(&mut body, model, &a.effort);
    let is_oauth = a.credential.starts_with("sk-ant-oat") || a.is_subscription;
    anthropic_send(&body, &a.credential, is_oauth).await
}

async fn gemini_chat(a: &ChatArgs) -> Result<String, String> {
    // Google retired the whole 2.5 line for new keys ("no longer available to new users"); 3.5 Flash is current.
    let model = if a.model.is_empty() { "gemini-3.5-flash" } else { a.model.as_str() };
    let mut contents: Vec<serde_json::Value> = a
        .history
        .iter()
        .map(|t| serde_json::json!({ "role": if t.role == "assistant" { "model" } else { "user" }, "parts": [{ "text": t.content }] }))
        .collect();
    contents.push(serde_json::json!({ "role": "user", "parts": [{ "text": a.message }] }));
    let body = serde_json::json!({
        "systemInstruction": { "parts": [{ "text": a.system }] },
        "contents": contents,
        "generationConfig": { "maxOutputTokens": 8192 }
    });
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model, a.credential
    );
    let client = reqwest::Client::new();
    let res = client.post(url).header("Content-Type", "application/json").json(&body).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("gemini {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string())
}

async fn ollama_chat(a: &ChatArgs) -> Result<String, String> {
    let model = if a.model.is_empty() { "llama3.2" } else { a.model.as_str() };
    let mut messages: Vec<serde_json::Value> = vec![serde_json::json!({ "role": "system", "content": a.system })];
    for t in &a.history {
        messages.push(serde_json::json!({ "role": if t.role == "assistant" { "assistant" } else { "user" }, "content": t.content }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": a.message }));
    let body = serde_json::json!({ "model": model, "stream": false, "messages": messages });
    let client = reqwest::Client::new();
    let res = client
        .post("http://localhost:11434/v1/chat/completions")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama isn't reachable ({}). Is it running?", e))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("ollama {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message")).and_then(|m| m.get("content")).and_then(|x| x.as_str()).unwrap_or("").to_string())
}

// Generic OpenAI-compatible chat (DeepSeek, Mistral, xAI Grok — all speak the /chat/completions shape).
async fn openai_compat_chat(a: &ChatArgs, base: &str, default_model: &str, label: &str) -> Result<String, String> {
    let model = if a.model.is_empty() { default_model } else { a.model.as_str() };
    let mut messages: Vec<serde_json::Value> = vec![serde_json::json!({ "role": "system", "content": a.system })];
    for t in &a.history {
        messages.push(serde_json::json!({ "role": if t.role == "assistant" { "assistant" } else { "user" }, "content": t.content }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": a.message }));
    let body = serde_json::json!({ "model": model, "stream": false, "messages": messages, "max_tokens": 8192 });
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", a.credential))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{} {}: {}", label, status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message")).and_then(|m| m.get("content")).and_then(|x| x.as_str()).unwrap_or("").to_string())
}

// GitHub Copilot: the credential is a GitHub OAuth token (from `copilot /login` on the CLI). We exchange it
// for a short-lived Copilot bearer token on every call, then hit the Copilot chat endpoint. Uses the user's
// own Copilot subscription — no API key, nothing billed to us.
async fn copilot_chat(a: &ChatArgs) -> Result<String, String> {
    let client = reqwest::Client::new();
    let tok_res = client
        .get("https://api.github.com/copilot_internal/v2/token")
        .header("Authorization", format!("token {}", a.credential))
        .header("User-Agent", "Keak/1.0")
        .header("Editor-Version", "Keak/1.0")
        .header("Editor-Plugin-Version", "Keak/1.0")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let tstatus = tok_res.status();
    let ttext = tok_res.text().await.map_err(|e| e.to_string())?;
    if !tstatus.is_success() {
        return Err(format!("copilot token {}: {} (is Copilot active on this account?)", tstatus.as_u16(), ttext.chars().take(160).collect::<String>()));
    }
    let tv: serde_json::Value = serde_json::from_str(&ttext).map_err(|e| e.to_string())?;
    let copilot_token = tv.get("token").and_then(|x| x.as_str())
        .ok_or_else(|| "Copilot didn't return a token. Sign in again with `copilot /login`.".to_string())?;
    let model = if a.model.is_empty() { "gpt-4o" } else { a.model.as_str() };
    let mut messages: Vec<serde_json::Value> = vec![serde_json::json!({ "role": "system", "content": a.system })];
    for t in &a.history {
        messages.push(serde_json::json!({ "role": if t.role == "assistant" { "assistant" } else { "user" }, "content": t.content }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": a.message }));
    let body = serde_json::json!({ "model": model, "messages": messages });
    let res = client
        .post("https://api.githubcopilot.com/chat/completions")
        .header("Authorization", format!("Bearer {}", copilot_token))
        .header("Content-Type", "application/json")
        .header("Editor-Version", "Keak/1.0")
        .header("Copilot-Integration-Id", "vscode-chat")
        .header("User-Agent", "Keak/1.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("copilot {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message")).and_then(|m| m.get("content")).and_then(|x| x.as_str()).unwrap_or("").to_string())
}

// Read the GitHub OAuth token the Copilot CLI stores after `copilot /login`, so the user just signs in on
// the CLI and Keak picks the token up — no pasting. Scans the known config locations across OSes.
#[tauri::command]
fn copilot_read_cli_token() -> Result<String, String> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    for var in ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"] {
        if let Ok(base) = std::env::var(var) {
            dirs.push(std::path::Path::new(&base).join("github-copilot"));
        }
    }
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        dirs.push(std::path::Path::new(&home).join(".config").join("github-copilot"));
        dirs.push(std::path::Path::new(&home).join(".copilot"));
    }
    for dir in dirs {
        for file in ["apps.json", "hosts.json"] {
            let path = dir.join(file);
            let Ok(raw) = std::fs::read_to_string(&path) else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
            if let Some(obj) = v.as_object() {
                for (_k, entry) in obj {
                    if let Some(tok) = entry.get("oauth_token").and_then(|x| x.as_str()) {
                        if !tok.is_empty() { return Ok(tok.to_string()); }
                    }
                }
            }
        }
    }
    Err("Couldn't find a Copilot login. Run `copilot /login` in a terminal first, then try again.".to_string())
}

// Read the Claude Code login token straight off disk, so the user doesn't have to copy/paste anything. Modern
// `claude setup-token` finishes in the browser and writes the OAuth login to ~/.claude/.credentials.json rather
// than printing a pasteable token. We pull claudeAiOauth.accessToken (an sk-ant-oat... subscription token).
#[tauri::command]
fn claude_read_cli_token() -> Result<String, String> {
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let base = std::path::Path::new(&home);
        paths.push(base.join(".claude").join(".credentials.json"));
        paths.push(base.join(".config").join("claude").join(".credentials.json"));
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        paths.push(std::path::Path::new(&xdg).join("claude").join(".credentials.json"));
    }
    for path in paths {
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        // Usual shape: { "claudeAiOauth": { "accessToken": "sk-ant-oat...", ... } }
        let tok = v.get("claudeAiOauth").and_then(|o| o.get("accessToken")).and_then(|x| x.as_str())
            .or_else(|| v.get("accessToken").and_then(|x| x.as_str()));
        if let Some(t) = tok { if !t.is_empty() { return Ok(t.to_string()); } }
    }
    Err("Couldn't find your Claude login on this computer. In a terminal run `claude setup-token`, sign in, then click this again. (Needs the Claude CLI: npm i -g @anthropic-ai/claude-code)".to_string())
}

// List the models the user has actually pulled locally, so the Connect UI can offer only those.
#[tauri::command]
async fn ollama_list_models() -> Result<String, String> {
    let client = reqwest::Client::new();
    let res = client
        .get("http://localhost:11434/api/tags")
        .send()
        .await
        .map_err(|e| format!("Ollama isn't reachable ({}). Is it running?", e))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("ollama {}: {}", status.as_u16(), text.chars().take(160).collect::<String>()));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let names: Vec<String> = v
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| arr.iter().filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())).collect())
        .unwrap_or_default();
    serde_json::to_string(&names).map_err(|e| e.to_string())
}

// Send a WhatsApp message via Meta's WhatsApp Cloud API. The user provides a token + phone number ID from a
// Meta app, and a recipient number. Used to deliver routine output to WhatsApp.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhatsappArgs { token: String, phone_number_id: String, to: String, #[serde(default)] text: String }
#[tauri::command]
async fn whatsapp_send(args: WhatsappArgs) -> Result<String, String> {
    let token = args.token.trim();
    let phone_id = args.phone_number_id.trim();
    let to = args.to.trim();
    if token.is_empty() || phone_id.is_empty() || to.is_empty() {
        return Err("Add your WhatsApp token, phone number ID and a recipient number first".into());
    }
    let url = format!("https://graph.facebook.com/v21.0/{}/messages", phone_id);
    let payload = serde_json::json!({
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": { "body": args.text }
    });
    let client = reqwest::Client::new();
    let res = client.post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("whatsapp {}: {}", status.as_u16(), text.chars().take(220).collect::<String>()));
    }
    Ok(text)
}

// Turn "start Keak when I log in" on or off. Combined with the tray (windows hide instead of quitting on
// close), this keeps Keak alive in the background so scheduled routines run even when the window is closed.
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    if enabled { m.enable().map_err(|e| e.to_string())?; } else { m.disable().map_err(|e| e.to_string())?; }
    m.is_enabled().map_err(|e| e.to_string())
}
#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

// Native "choose a folder" dialog so the user picks their Second Brain from File Explorer instead of typing a
// path. Returns the chosen absolute path, or an error string if they cancelled.
#[tauri::command]
async fn pick_folder() -> Result<String, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title("Choose your Second Brain folder")
        .pick_folder()
        .await;
    match picked {
        Some(f) => Ok(f.path().to_string_lossy().to_string()),
        None => Err("cancelled".into()),
    }
}

// ---- Second Brain OS: sandboxed filesystem access to the user's connected folder ----
// Every path is joined under the connected root and `..` / drive-letter escapes are rejected, so Keak can
// only ever touch inside the folder the user chose. Writes/deletes also carry the user's permission level.
fn sb_join(root: &str, rel: &str) -> Result<std::path::PathBuf, String> {
    if root.trim().is_empty() { return Err("No Second Brain folder connected".into()); }
    let rel = rel.replace('\\', "/");
    let rel = rel.trim().trim_start_matches('/');
    if rel.contains(':') { return Err("That path isn't inside your Second Brain folder.".into()); }
    for part in rel.split('/') {
        if part == ".." { return Err("That path escapes your Second Brain folder.".into()); }
    }
    Ok(std::path::Path::new(root.trim()).join(rel))
}
fn sb_skip_dir(name: &str) -> bool {
    matches!(name, "node_modules" | ".git" | "target" | "dist" | "build" | ".next" | ".venv" | "__pycache__" | ".cache" | ".gradle" | "vendor" | ".turbo")
}
fn sb_walk(dir: &std::path::Path, base: &std::path::Path, depth: u32, max_depth: u32, out: &mut Vec<String>, max_entries: usize) {
    if depth > max_depth || out.len() >= max_entries { return; }
    let Ok(rd) = std::fs::read_dir(dir) else { return; };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        if out.len() >= max_entries { return; }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".claude" { continue; }
        let path = e.path();
        let is_dir = path.is_dir();
        if is_dir && sb_skip_dir(&name) { continue; }
        let rel = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        out.push(if is_dir { format!("{}/", rel) } else { rel });
        if is_dir { sb_walk(&path, base, depth + 1, max_depth, out, max_entries); }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SbTreeArgs { root: String, #[serde(default)] max_depth: u32, #[serde(default)] max_entries: u32 }
#[tauri::command]
async fn sb_tree(args: SbTreeArgs) -> Result<String, String> {
    let root = std::path::Path::new(args.root.trim());
    if !root.is_dir() { return Err("Second Brain folder not found. Check the path.".into()); }
    let max_depth = if args.max_depth == 0 { 2 } else { args.max_depth };
    let max_entries = if args.max_entries == 0 { 800 } else { args.max_entries } as usize;
    let mut out: Vec<String> = Vec::new();
    sb_walk(root, root, 1, max_depth, &mut out, max_entries);
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SbPathArgs { root: String, path: String }
#[tauri::command]
async fn sb_read(args: SbPathArgs) -> Result<String, String> {
    let p = sb_join(&args.root, &args.path)?;
    let meta = std::fs::metadata(&p).map_err(|_| "File not found.".to_string())?;
    if meta.len() > 400_000 { return Err("That file is too large to read (over 400 KB).".into()); }
    std::fs::read_to_string(&p).map_err(|_| "Couldn't read that file (it may be binary).".to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SbWriteArgs { root: String, path: String, #[serde(default)] content: String, #[serde(default)] perm: String }
#[tauri::command]
async fn sb_write(args: SbWriteArgs) -> Result<String, String> {
    let p = sb_join(&args.root, &args.path)?;
    let exists = p.exists();
    match args.perm.as_str() {
        "read" => return Err("Your Second Brain is set to read-only.".into()),
        "create" => if exists { return Err("That file already exists and your permission is create-only.".into()); },
        "edit" => if !exists { return Err("That file doesn't exist yet and your permission is edit-only.".into()); },
        _ => {} // "full" (create + edit + delete) or unset -> allowed
    }
    if let Some(parent) = p.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    std::fs::write(&p, args.content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
async fn sb_mkdir(args: SbWriteArgs) -> Result<String, String> {
    if args.perm == "read" || args.perm == "edit" { return Err("You don't have permission to create folders.".into()); }
    let p = sb_join(&args.root, &args.path)?;
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
async fn sb_delete(args: SbWriteArgs) -> Result<String, String> {
    if args.perm != "full" { return Err("Deleting isn't allowed with your current permission.".into()); }
    let p = sb_join(&args.root, &args.path)?;
    if !p.exists() { return Err("That path doesn't exist.".into()); }
    if p.is_dir() { std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?; }
    else { std::fs::remove_file(&p).map_err(|e| e.to_string())?; }
    Ok(format!("Deleted {}", args.path))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SbSearchArgs { root: String, query: String, #[serde(default)] max_results: u32 }
#[tauri::command]
async fn sb_search(args: SbSearchArgs) -> Result<String, String> {
    let root = std::path::Path::new(args.root.trim());
    if !root.is_dir() { return Err("Second Brain folder not found.".into()); }
    let q = args.query.trim().to_lowercase();
    if q.is_empty() { return Err("Nothing to search for.".into()); }
    let max = if args.max_results == 0 { 30 } else { args.max_results } as usize;
    let mut hits: Vec<serde_json::Value> = Vec::new();
    // Budget: cap files scanned and total bytes read so search stays fast on a huge folder (never freezes the app).
    let mut budget = SearchBudget { files: 0, bytes: 0 };
    fn walk(dir: &std::path::Path, base: &std::path::Path, q: &str, hits: &mut Vec<serde_json::Value>, max: usize, budget: &mut SearchBudget) {
        if hits.len() >= max || budget.files >= 4000 || budget.bytes >= 8_000_000 { return; }
        let Ok(rd) = std::fs::read_dir(dir) else { return; };
        for e in rd.filter_map(|e| e.ok()) {
            if hits.len() >= max || budget.files >= 4000 || budget.bytes >= 8_000_000 { return; }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name != ".claude" { continue; }
            let path = e.path();
            if path.is_dir() { if !sb_skip_dir(&name) { walk(&path, base, q, hits, max, budget); } continue; }
            budget.files += 1;
            let rel = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            let name_hit = name.to_lowercase().contains(q);
            let mut snippet = String::new();
            if let Ok(meta) = std::fs::metadata(&path) {
                if meta.len() < 120_000 {
                    if let Ok(txt) = std::fs::read_to_string(&path) {
                        budget.bytes += txt.len();
                        if let Some(pos) = txt.to_lowercase().find(q) {
                            let start = pos.saturating_sub(60);
                            snippet = txt.chars().skip(start).take(180).collect::<String>().replace(['\n', '\r'], " ");
                        }
                    }
                }
            }
            if name_hit || !snippet.is_empty() { hits.push(serde_json::json!({ "path": rel, "snippet": snippet })); }
        }
    }
    walk(root, root, &q, &mut hits, max, &mut budget);
    serde_json::to_string(&hits).map_err(|e| e.to_string())
}
struct SearchBudget { files: usize, bytes: usize }

// ---- Second Brain graph: turn the connected folder into nodes + links for a visual (2D/3D) map ----
// Nodes = folders and files. Links = folder containment (parent->child) PLUS knowledge links parsed from
// markdown/text: Obsidian-style [[wikilinks]] (matched by file stem) and [label](relative/path.md) links.
// Everything is budget-capped so a huge folder never freezes the app.
fn sb_is_texty(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".md") || n.ends_with(".markdown") || n.ends_with(".mdx") || n.ends_with(".txt")
}
fn sb_node_type(name: &str, is_dir: bool) -> &'static str {
    if is_dir { return "dir"; }
    let n = name.to_lowercase();
    if n.ends_with(".md") || n.ends_with(".markdown") || n.ends_with(".mdx") { "md" }
    else if n.ends_with(".txt") { "text" }
    else if n.ends_with(".png") || n.ends_with(".jpg") || n.ends_with(".jpeg") || n.ends_with(".gif")
         || n.ends_with(".webp") || n.ends_with(".svg") || n.ends_with(".mp4") || n.ends_with(".mov")
         || n.ends_with(".mp3") || n.ends_with(".wav") || n.ends_with(".pdf") { "media" }
    else if n.ends_with(".ts") || n.ends_with(".tsx") || n.ends_with(".js") || n.ends_with(".jsx")
         || n.ends_with(".py") || n.ends_with(".rs") || n.ends_with(".html") || n.ends_with(".css")
         || n.ends_with(".json") || n.ends_with(".toml") || n.ends_with(".sh") { "code" }
    else { "file" }
}
// Resolve a markdown link target (relative to the file's dir) into a posix path from the root.
fn sb_resolve_rel(base_dir: &str, target: &str) -> String {
    let t = target.split('#').next().unwrap_or(target).trim();
    let mut parts: Vec<&str> = if base_dir.is_empty() { Vec::new() } else { base_dir.split('/').collect() };
    for seg in t.split('/') {
        match seg {
            "" | "." => {}
            ".." => { parts.pop(); }
            s => parts.push(s),
        }
    }
    parts.join("/")
}
// Breadth-first so the shallow structure (the main folders and their contents) is guaranteed to appear
// before the node cap — deep leaves get truncated, never the top-level regions. Skips dot-folders
// (.git, .claude, …) and heavy build dirs so a real user's brain shows its actual folders, not tooling noise.
fn sb_graph_walk(root: &std::path::Path, max_depth: u32, max_nodes: usize)
    -> Vec<(String, String, &'static str)> {
    use std::collections::VecDeque;
    let mut nodes: Vec<(String, String, &'static str)> = Vec::new();
    let mut queue: VecDeque<(std::path::PathBuf, u32)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), 1));
    while let Some((dir, depth)) = queue.pop_front() {
        if depth > max_depth || nodes.len() >= max_nodes { continue; }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue; };
        let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            if nodes.len() >= max_nodes { break; }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; } // hide dot-folders/files (.git, .claude, .env…)
            let path = e.path();
            let is_dir = path.is_dir();
            if is_dir && sb_skip_dir(&name) { continue; }
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            let ty = sb_node_type(&name, is_dir);
            nodes.push((rel, name, ty));
            if is_dir { queue.push_back((path, depth + 1)); }
        }
    }
    nodes
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SbGraphArgs { root: String, #[serde(default)] max_depth: u32, #[serde(default)] max_nodes: u32 }
#[tauri::command]
async fn sb_graph(args: SbGraphArgs) -> Result<String, String> {
    let root = std::path::Path::new(args.root.trim());
    if !root.is_dir() { return Err("Second Brain folder not found. Check the path.".into()); }
    let max_depth = if args.max_depth == 0 { 6 } else { args.max_depth };
    let max_nodes = if args.max_nodes == 0 { 2500 } else { args.max_nodes } as usize;

    // Pass 1: collect every node (folders + files), breadth-first.
    let mut raw = sb_graph_walk(root, max_depth, max_nodes);
    // The centre of the map: one hub node all the top-level folders hang off of.
    raw.insert(0, ("__root__".to_string(), "Second Brain".to_string(), "root"));

    // Fast lookups for link resolution.
    use std::collections::{HashMap, HashSet};
    let node_set: HashSet<String> = raw.iter().map(|(id, _, _)| id.clone()).collect();
    // stem (lowercased basename without extension) -> node id, for [[wikilinks]]. First writer wins.
    let mut stem_map: HashMap<String, String> = HashMap::new();
    for (id, name, ty) in &raw {
        if *ty == "md" || *ty == "text" {
            let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name).to_lowercase();
            stem_map.entry(stem).or_insert_with(|| id.clone());
        }
    }

    let mut links: Vec<serde_json::Value> = Vec::new();
    let mut seen_links: HashSet<(String, String)> = HashSet::new();
    let push_link = |links: &mut Vec<serde_json::Value>, seen: &mut HashSet<(String, String)>,
                     s: &str, tgt: &str, kind: &str| {
        if s == tgt { return; }
        let key = (s.to_string(), tgt.to_string());
        if seen.contains(&key) { return; }
        seen.insert(key);
        links.push(serde_json::json!({ "source": s, "target": tgt, "kind": kind }));
    };

    // Containment links: each node -> its parent folder. Top-level nodes hang off the "Second Brain" hub.
    for (id, _, ty) in &raw {
        if *ty == "root" { continue; }
        if let Some(pos) = id.rfind('/') {
            let parent = &id[..pos];
            if node_set.contains(parent) {
                push_link(&mut links, &mut seen_links, parent, id, "tree");
            }
        } else {
            push_link(&mut links, &mut seen_links, "__root__", id, "tree");
        }
    }

    // Pass 2: parse knowledge links out of markdown/text files (budget-capped).
    let mut bytes_read: usize = 0;
    for (id, name, ty) in &raw {
        if bytes_read >= 6_000_000 { break; }
        if !(*ty == "md" || *ty == "text") || !sb_is_texty(name) { continue; }
        let full = root.join(id); // Path::join accepts posix separators on Windows too
        let Ok(meta) = std::fs::metadata(&full) else { continue; };
        if meta.len() > 300_000 { continue; }
        let Ok(txt) = std::fs::read_to_string(&full) else { continue; };
        bytes_read += txt.len();
        let base_dir = id.rfind('/').map(|p| &id[..p]).unwrap_or("");
        let bytes = txt.as_bytes();
        let mut i = 0usize;
        while i + 1 < bytes.len() {
            // [[wikilink]] (Obsidian) — resolve by file stem.
            if bytes[i] == b'[' && bytes[i + 1] == b'[' {
                if let Some(end) = txt[i + 2..].find("]]") {
                    let inner = &txt[i + 2..i + 2 + end];
                    let target = inner.split('|').next().unwrap_or(inner)
                        .split('#').next().unwrap_or(inner).trim().to_lowercase();
                    if let Some(tid) = stem_map.get(&target) {
                        push_link(&mut links, &mut seen_links, id, tid, "link");
                    }
                    i += 4 + end;
                    continue;
                }
            }
            // [label](target) — markdown link to a file inside the folder.
            if bytes[i] == b']' && i + 1 < bytes.len() && bytes[i + 1] == b'(' {
                if let Some(end) = txt[i + 2..].find(')') {
                    let target = &txt[i + 2..i + 2 + end];
                    let low = target.trim().to_lowercase();
                    if !low.is_empty() && !low.contains("://") && !low.starts_with("mailto:")
                        && !low.starts_with('#') {
                        let resolved = sb_resolve_rel(base_dir, target.trim());
                        if node_set.contains(&resolved) {
                            push_link(&mut links, &mut seen_links, id, &resolved, "link");
                        } else {
                            let with_md = format!("{}.md", resolved);
                            if node_set.contains(&with_md) {
                                push_link(&mut links, &mut seen_links, id, &with_md, "link");
                            }
                        }
                    }
                    i += 2 + end;
                    continue;
                }
            }
            i += 1;
        }
    }

    // Degree per node (link count) so the view can size hubs bigger.
    let mut deg: HashMap<&str, u32> = HashMap::new();
    for l in &links {
        if let (Some(s), Some(t)) = (l["source"].as_str(), l["target"].as_str()) {
            *deg.entry(s).or_insert(0) += 1;
            *deg.entry(t).or_insert(0) += 1;
        }
    }
    let nodes: Vec<serde_json::Value> = raw.iter().map(|(id, name, ty)| {
        let depth = id.matches('/').count();
        serde_json::json!({ "id": id, "name": name, "type": ty, "deg": deg.get(id.as_str()).copied().unwrap_or(0), "depth": depth })
    }).collect();

    serde_json::to_string(&serde_json::json!({ "nodes": nodes, "links": links })).map_err(|e| e.to_string())
}

#[tauri::command]
async fn cu_chat(args: ChatArgs) -> Result<String, String> {
    match args.provider.as_str() {
        "openai" => openai_chat(&args).await,
        "claude" => claude_chat(&args).await,
        "gemini" => gemini_chat(&args).await,
        "ollama" => ollama_chat(&args).await,
        "deepseek" => openai_compat_chat(&args, "https://api.deepseek.com", "deepseek-chat", "deepseek").await,
        "mistral" => openai_compat_chat(&args, "https://api.mistral.ai/v1", "mistral-large-latest", "mistral").await,
        "xai" => openai_compat_chat(&args, "https://api.x.ai/v1", "grok-4", "grok").await,
        "copilot" => copilot_chat(&args).await,
        other => Err(format!("provider '{}' isn't wired for Keak AI yet", other)),
    }
}

#[derive(serde::Deserialize)]
struct TtsArgs {
    credential: String,      // an OpenAI API key (sk-...). The ChatGPT subscription token can't reach this endpoint.
    voice: String,           // alloy | echo | fable | onyx | nova | shimmer
    model: String,           // "" -> gpt-4o-mini-tts
    text: String,
}
// Premium spoken voice on the USER's own OpenAI key: /v1/audio/speech returns mp3 bytes, which we hand back
// base64 so the webview can play it with a data: URL. Costs Pep nothing — it runs on the user's key.
#[tauri::command]
async fn openai_tts(args: TtsArgs) -> Result<String, String> {
    use base64::Engine;
    let key = args.credential.trim();
    if !key.starts_with("sk-") {
        return Err("OpenAI premium voice needs an OpenAI API key (sk-...)".into());
    }
    let model = if args.model.is_empty() { "gpt-4o-mini-tts" } else { args.model.as_str() };
    let voice = if args.voice.is_empty() { "nova" } else { args.voice.as_str() };
    let body = serde_json::json!({ "model": model, "voice": voice, "input": args.text, "response_format": "mp3" });
    let client = reqwest::Client::new();
    let res = client
        .post("https://api.openai.com/v1/audio/speech")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", key))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let t = res.text().await.unwrap_or_default();
        return Err(format!("openai tts {}: {}", status.as_u16(), t.chars().take(160).collect::<String>()));
    }
    let buf = res.bytes().await.map_err(|e| e.to_string())?;
    if buf.is_empty() { return Err("openai tts returned empty audio".into()); }
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

// Wrap raw 16-bit PCM (mono) in a WAV header so the webview can play it via a data: URL.
fn pcm_to_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let channels: u16 = 1;
    let bits: u16 = 16;
    let byte_rate = sample_rate * channels as u32 * (bits as u32 / 8);
    let block_align = channels * (bits / 8);
    let data_len = pcm.len() as u32;
    let mut w = Vec::with_capacity(44 + pcm.len());
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data_len).to_le_bytes());
    w.extend_from_slice(b"WAVE");
    w.extend_from_slice(b"fmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());          // PCM
    w.extend_from_slice(&channels.to_le_bytes());
    w.extend_from_slice(&sample_rate.to_le_bytes());
    w.extend_from_slice(&byte_rate.to_le_bytes());
    w.extend_from_slice(&block_align.to_le_bytes());
    w.extend_from_slice(&bits.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&data_len.to_le_bytes());
    w.extend_from_slice(pcm);
    w
}

#[derive(serde::Deserialize)]
struct GeminiTtsArgs {
    credential: String,   // the user's own Gemini API key (free tier available in Google AI Studio)
    voice: String,        // Kore | Aoede | Puck | Charon | Fenrir | Leda ...
    model: String,        // "" -> gemini-2.5-flash-preview-tts
    text: String,
}
// Premium spoken voice on the USER's own Gemini key. Gemini TTS returns base64 PCM (24kHz, 16-bit, mono) in
// inlineData; we wrap it in a WAV header and hand back base64 WAV for the webview to play. Free to Pep — it
// runs on the user's key, so even a Claude-only user can paste a free Gemini key just for the voice.
#[tauri::command]
async fn gemini_tts(args: GeminiTtsArgs) -> Result<String, String> {
    use base64::Engine;
    let key = args.credential.trim();
    if key.is_empty() { return Err("Gemini voice needs a Gemini API key".into()); }
    let voice = if args.voice.is_empty() { "Kore" } else { args.voice.as_str() };
    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": args.text }] }],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice } } }
        }
    });
    // Google keeps retiring TTS model IDs for new keys, so try the current one first and fall back to older
    // names until one works. If the caller pinned a model, use only that.
    let candidates: Vec<&str> = if args.model.is_empty() {
        vec!["gemini-3.5-flash-preview-tts", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"]
    } else {
        vec![args.model.as_str()]
    };
    let client = reqwest::Client::new();
    let mut last_err = String::from("gemini tts failed");
    let mut text = String::new();
    let mut ok = false;
    for model in &candidates {
        let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}", model, key);
        let res = match client.post(url).header("Content-Type", "application/json").json(&body).send().await {
            Ok(r) => r,
            Err(e) => { last_err = e.to_string(); continue; }
        };
        let status = res.status();
        let t = res.text().await.unwrap_or_default();
        if status.is_success() { text = t; ok = true; break; }
        last_err = format!("gemini tts {}: {}", status.as_u16(), t.chars().take(160).collect::<String>());
        // Only keep trying on "model not available / not found"; a real error (bad key) should surface now.
        if !(status.as_u16() == 404 || t.contains("not available") || t.contains("not found")) { break; }
    }
    if !ok { return Err(last_err); }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let part = v.get("candidates").and_then(|c| c.get(0)).and_then(|c| c.get("content")).and_then(|c| c.get("parts")).and_then(|p| p.get(0));
    let b64_pcm = part.and_then(|p| p.get("inlineData")).and_then(|d| d.get("data")).and_then(|d| d.as_str()).unwrap_or("");
    if b64_pcm.is_empty() { return Err("gemini tts returned no audio".into()); }
    // Detect the sample rate from the mimeType if present (e.g. "audio/L16;codec=pcm;rate=24000"), else 24000.
    let mime = part.and_then(|p| p.get("inlineData")).and_then(|d| d.get("mimeType")).and_then(|d| d.as_str()).unwrap_or("");
    let rate = mime.split("rate=").nth(1).and_then(|s| s.split(|c: char| !c.is_ascii_digit()).next()).and_then(|s| s.parse::<u32>().ok()).unwrap_or(24000);
    let pcm = base64::engine::general_purpose::STANDARD.decode(b64_pcm).map_err(|e| e.to_string())?;
    let wav = pcm_to_wav(&pcm, rate);
    Ok(base64::engine::general_purpose::STANDARD.encode(&wav))
}

// ---- Google connection (Calendar / Gmail / Drive) ---------------------------------------------------
// Desktop OAuth via a loopback redirect: open Google's consent page pointing at http://127.0.0.1:<port>,
// catch the redirect on a one-shot local server, exchange the code for tokens. Uses the user's own Google
// OAuth "Desktop app" client (id + secret), so it acts on THEIR Google account and costs Pep nothing.
fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(v) = u8::from_str_radix(hex, 16) { out.push(v); i += 3; } else { out.push(bytes[i]); i += 1; }
            }
            b'+' => { out.push(b' '); i += 1; }
            b => { out.push(b); i += 1; }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
fn query_param(path: &str, key: &str) -> Option<String> {
    path.split('?').nth(1)?.split('&').find_map(|kv| {
        let mut it = kv.splitn(2, '=');
        if it.next() == Some(key) { it.next().map(urldecode) } else { None }
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleConnectArgs { client_id: String, client_secret: String }

#[tauri::command]
async fn google_connect(app: AppHandle, args: GoogleConnectArgs) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let cid = args.client_id.trim();
    let csecret = args.client_secret.trim();
    if cid.is_empty() || csecret.is_empty() { return Err("Enter your Google client ID and secret first".into()); }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{}", port);
    // Scopes: Calendar (events), Gmail SEND only (send-only is a "sensitive" scope → easy verification, no CASA
    // audit; reading the inbox would need the "restricted" gmail.modify), Drive (files the app creates), email.
    let scope = "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/userinfo.email";
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        urlencode(cid), urlencode(&redirect), urlencode(scope)
    );
    app.opener().open_url(&auth_url, None::<&str>).map_err(|e| e.to_string())?;

    // Wait (up to 3 min) for Google to redirect back with the code.
    let (mut stream, _) = tokio::time::timeout(std::time::Duration::from_secs(180), listener.accept())
        .await.map_err(|_| "Google sign-in timed out. Try again.".to_string())?
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 16384];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let first = req.lines().next().unwrap_or("");
    let path = first.split_whitespace().nth(1).unwrap_or("");
    let code = query_param(path, "code").unwrap_or_default();
    let oauth_err = query_param(path, "error");
    let body = "<!doctype html><html><body style='font-family:system-ui;padding:48px;background:#F5EDD8;color:#2C1508'><h2>Keak is connected to Google.</h2><p>You can close this tab and go back to Keak.</p></body></html>";
    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.flush().await;
    if let Some(e) = oauth_err { return Err(format!("Google sign-in was denied: {}", e)); }
    if code.is_empty() { return Err("Google didn't return an authorization code".into()); }

    // Exchange the code for access + refresh tokens.
    let client = reqwest::Client::new();
    let res = client.post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", cid), ("client_secret", csecret), ("code", code.as_str()),
            ("grant_type", "authorization_code"), ("redirect_uri", redirect.as_str()),
        ])
        .send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("google token {}: {}", status.as_u16(), text.chars().take(220).collect::<String>())); }
    Ok(text) // { access_token, refresh_token, expires_in, scope, token_type }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleRefreshArgs { client_id: String, client_secret: String, refresh_token: String }

#[tauri::command]
async fn google_refresh(args: GoogleRefreshArgs) -> Result<String, String> {
    let client = reqwest::Client::new();
    let res = client.post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", args.client_id.trim()), ("client_secret", args.client_secret.trim()),
            ("refresh_token", args.refresh_token.trim()), ("grant_type", "refresh_token"),
        ])
        .send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("google refresh {}: {}", status.as_u16(), text.chars().take(200).collect::<String>())); }
    Ok(text) // { access_token, expires_in, ... }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GCalArgs {
    access_token: String,
    summary: String,
    #[serde(default)] description: String,
    start: String,          // RFC3339, e.g. 2026-07-12T17:00:00
    end: String,
    #[serde(default)] timezone: String,
}
// Create a real event on the user's primary Google Calendar. Returns the event JSON (incl. htmlLink).
#[tauri::command]
async fn google_calendar_create(args: GCalArgs) -> Result<String, String> {
    let tz = if args.timezone.trim().is_empty() { "UTC" } else { args.timezone.trim() };
    let body = serde_json::json!({
        "summary": args.summary,
        "description": args.description,
        "start": { "dateTime": args.start, "timeZone": tz },
        "end": { "dateTime": args.end, "timeZone": tz },
    });
    let client = reqwest::Client::new();
    let res = client.post("https://www.googleapis.com/calendar/v3/calendars/primary/events")
        .header("Authorization", format!("Bearer {}", args.access_token.trim()))
        .json(&body)
        .send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("calendar {}: {}", status.as_u16(), text.chars().take(220).collect::<String>())); }
    Ok(text)
}

// ---- YouTube (Data API v3, read-only) ----
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeArgs { access_token: String, path: String, #[serde(default)] query: String }
// Generic GET against the YouTube Data API. `path` is an endpoint like "channels" or "search"; `query` is the
// already-URL-encoded query string. Returns the raw JSON so the model can read the numbers/titles it needs.
#[tauri::command]
async fn youtube_get(args: YoutubeArgs) -> Result<String, String> {
    let path = args.path.trim().trim_start_matches('/');
    let mut url = format!("https://www.googleapis.com/youtube/v3/{}", path);
    let q = args.query.trim();
    if !q.is_empty() { url.push('?'); url.push_str(q.trim_start_matches('?')); }
    let client = reqwest::Client::new();
    let res = client.get(&url)
        .header("Authorization", format!("Bearer {}", args.access_token.trim()))
        .send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("youtube {}: {}", status.as_u16(), text.chars().take(240).collect::<String>())); }
    Ok(text)
}

// ---- Gmail ----
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GmailListArgs { access_token: String, #[serde(default)] query: String, #[serde(default)] max: u32 }
// List recent messages (default: unread in inbox) with From + Subject + snippet. Returns a JSON array string.
#[tauri::command]
async fn gmail_list(args: GmailListArgs) -> Result<String, String> {
    let q = if args.query.trim().is_empty() { "in:inbox is:unread" } else { args.query.trim() };
    let max = if args.max == 0 { 5 } else { args.max.min(10) };
    let client = reqwest::Client::new();
    let auth = format!("Bearer {}", args.access_token.trim());
    let list_url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults={}&q={}", max, urlencode(q));
    let res = client.get(&list_url).header("Authorization", &auth).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("gmail {}: {}", status.as_u16(), text.chars().take(200).collect::<String>())); }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let empty = vec![];
    let ids = v.get("messages").and_then(|m| m.as_array()).unwrap_or(&empty);
    let mut out: Vec<serde_json::Value> = Vec::new();
    for m in ids {
        let id = m.get("id").and_then(|x| x.as_str()).unwrap_or("");
        if id.is_empty() { continue; }
        let get_url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=metadata&metadataHeaders=From&metadataHeaders=Subject", id);
        let mr = client.get(&get_url).header("Authorization", &auth).send().await.map_err(|e| e.to_string())?;
        if !mr.status().is_success() { continue; }
        let mv: serde_json::Value = serde_json::from_str(&mr.text().await.unwrap_or_default()).unwrap_or(serde_json::json!({}));
        let mut from = ""; let mut subject = "";
        if let Some(hs) = mv.get("payload").and_then(|p| p.get("headers")).and_then(|h| h.as_array()) {
            for h in hs {
                let name = h.get("name").and_then(|x| x.as_str()).unwrap_or("");
                let val = h.get("value").and_then(|x| x.as_str()).unwrap_or("");
                if name.eq_ignore_ascii_case("From") { from = val; }
                if name.eq_ignore_ascii_case("Subject") { subject = val; }
            }
        }
        let snippet = mv.get("snippet").and_then(|s| s.as_str()).unwrap_or("");
        let thread_id = mv.get("threadId").and_then(|s| s.as_str()).unwrap_or("");
        out.push(serde_json::json!({ "id": id, "threadId": thread_id, "from": from, "subject": subject, "snippet": snippet }));
    }
    Ok(serde_json::to_string(&out).unwrap_or_else(|_| "[]".into()))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GmailSendArgs {
    access_token: String, to: String, subject: String, body: String,
    #[serde(default)] thread_id: String,
}
// Send an email (optionally as a reply within a thread). Returns the sent message JSON.
#[tauri::command]
async fn gmail_send(args: GmailSendArgs) -> Result<String, String> {
    use base64::Engine;
    let raw = format!(
        "To: {}\r\nSubject: {}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{}",
        args.to.trim(), args.subject.trim(), args.body
    );
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw.as_bytes());
    let mut body = serde_json::json!({ "raw": encoded });
    if !args.thread_id.trim().is_empty() { body["threadId"] = serde_json::json!(args.thread_id.trim()); }
    let client = reqwest::Client::new();
    let res = client.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
        .header("Authorization", format!("Bearer {}", args.access_token.trim()))
        .json(&body).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("gmail send {}: {}", status.as_u16(), text.chars().take(220).collect::<String>())); }
    Ok(text)
}

// ---- Drive ----
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveCreateArgs { access_token: String, name: String, #[serde(default)] mime: String, content: String }
// Create a file in the user's Drive (multipart: metadata + content). Returns { id, name, webViewLink }.
#[tauri::command]
async fn drive_create(args: DriveCreateArgs) -> Result<String, String> {
    let mime = if args.mime.trim().is_empty() { "text/plain" } else { args.mime.trim() };
    let boundary = "keakboundary7f3a1c9d";
    let meta = serde_json::json!({ "name": args.name }).to_string();
    let body = format!(
        "--{b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{b}\r\nContent-Type: {mime}\r\n\r\n{content}\r\n--{b}--",
        b = boundary, meta = meta, mime = mime, content = args.content
    );
    let client = reqwest::Client::new();
    let res = client.post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink")
        .header("Authorization", format!("Bearer {}", args.access_token.trim()))
        .header("Content-Type", format!("multipart/related; boundary={}", boundary))
        .body(body).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("drive {}: {}", status.as_u16(), text.chars().take(220).collect::<String>())); }
    Ok(text)
}

// ============================ Microsoft (Graph) ============================
// Outlook Calendar / Mail / OneDrive on the user's own Microsoft account, via a
// public-client OAuth code flow (loopback redirect + PKCE, no confidential secret
// needed). Mirrors the Google commands above.

// PKCE code_verifier — 64 chars from the unreserved set. No `rand` crate: seed an
// xorshift PRNG from the clock + pid (plenty of entropy for a one-shot desktop flow).
fn pkce_verifier() -> String {
    let charset = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0x9e3779b9);
    seed ^= (std::process::id() as u64).rotate_left(21);
    if seed == 0 { seed = 0x9e3779b97f4a7c15; }
    let mut out = String::with_capacity(64);
    for _ in 0..64 {
        seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
        out.push(charset[(seed % charset.len() as u64) as usize] as char);
    }
    out
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MsConnectArgs { client_id: String, #[serde(default)] client_secret: String }

#[tauri::command]
async fn ms_connect(app: AppHandle, args: MsConnectArgs) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let cid = args.client_id.trim();
    if cid.is_empty() { return Err("Enter your Microsoft application (client) ID first".into()); }
    let csecret = args.client_secret.trim(); // optional — only for confidential (web) app registrations
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // Azure loopback registration is "http://localhost" (any port allowed at runtime); localhost resolves to 127.0.0.1.
    let redirect = format!("http://localhost:{}", port);
    let verifier = pkce_verifier();
    // Delegated Graph scopes: Calendar (read/write), Mail send-only, OneDrive files, sign-in + profile.
    let scope = "offline_access openid profile email User.Read Calendars.ReadWrite Mail.Send Files.ReadWrite";
    let auth_url = format!(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id={}&response_type=code&redirect_uri={}&response_mode=query&scope={}&code_challenge={}&code_challenge_method=plain&prompt=select_account",
        urlencode(cid), urlencode(&redirect), urlencode(scope), urlencode(&verifier)
    );
    app.opener().open_url(&auth_url, None::<&str>).map_err(|e| e.to_string())?;

    let (mut stream, _) = tokio::time::timeout(std::time::Duration::from_secs(180), listener.accept())
        .await.map_err(|_| "Microsoft sign-in timed out. Try again.".to_string())?
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 16384];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let first = req.lines().next().unwrap_or("");
    let path = first.split_whitespace().nth(1).unwrap_or("");
    let code = query_param(path, "code").unwrap_or_default();
    let oauth_err = query_param(path, "error");
    let body = "<!doctype html><html><body style='font-family:system-ui;padding:48px;background:#F5EDD8;color:#2C1508'><h2>Keak is connected to Microsoft.</h2><p>You can close this tab and go back to Keak.</p></body></html>";
    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.flush().await;
    if let Some(e) = oauth_err { return Err(format!("Microsoft sign-in was denied: {}", e)); }
    if code.is_empty() { return Err("Microsoft didn't return an authorization code".into()); }

    let client = reqwest::Client::new();
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", cid), ("code", code.as_str()), ("grant_type", "authorization_code"),
        ("redirect_uri", redirect.as_str()), ("code_verifier", verifier.as_str()),
    ];
    if !csecret.is_empty() { form.push(("client_secret", csecret)); }
    let res = client.post("https://login.microsoftonline.com/common/oauth2/v2.0/token")
        .form(&form).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("microsoft token {}: {}", status.as_u16(), text.chars().take(240).collect::<String>())); }
    Ok(text) // { access_token, refresh_token, expires_in, scope, token_type }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MsRefreshArgs { client_id: String, #[serde(default)] client_secret: String, refresh_token: String }

#[tauri::command]
async fn ms_refresh(args: MsRefreshArgs) -> Result<String, String> {
    let cid = args.client_id.trim();
    let csecret = args.client_secret.trim();
    let rt = args.refresh_token.trim();
    let scope = "offline_access openid profile email User.Read Calendars.ReadWrite Mail.Send Files.ReadWrite";
    let client = reqwest::Client::new();
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", cid), ("refresh_token", rt), ("grant_type", "refresh_token"), ("scope", scope),
    ];
    if !csecret.is_empty() { form.push(("client_secret", csecret)); }
    let res = client.post("https://login.microsoftonline.com/common/oauth2/v2.0/token")
        .form(&form).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("microsoft refresh {}: {}", status.as_u16(), text.chars().take(200).collect::<String>())); }
    Ok(text)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MsCalArgs {
    access_token: String,
    summary: String,
    #[serde(default)] description: String,
    start: String,          // RFC3339 local, e.g. 2026-07-12T17:00:00
    end: String,
    #[serde(default)] timezone: String,
}
// Create an event on the user's Outlook calendar. Returns the event JSON (incl. webLink).
#[tauri::command]
async fn ms_calendar_create(args: MsCalArgs) -> Result<String, String> {
    let tz = if args.timezone.trim().is_empty() { "UTC" } else { args.timezone.trim() };
    let body = serde_json::json!({
        "subject": args.summary,
        "body": { "contentType": "text", "content": args.description },
        "start": { "dateTime": args.start, "timeZone": tz },
        "end": { "dateTime": args.end, "timeZone": tz },
    });
    let client = reqwest::Client::new();
    let res = client.post("https://graph.microsoft.com/v1.0/me/events")
        .header("Authorization", format!("Bearer {}", args.access_token.trim()))
        .json(&body).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("outlook calendar {}: {}", status.as_u16(), text.chars().take(240).collect::<String>())); }
    Ok(text)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MsMailArgs { access_token: String, to: String, subject: String, body: String }
// Send an email from the user's Outlook account. sendMail returns 202 with an empty body.
#[tauri::command]
async fn ms_mail_send(args: MsMailArgs) -> Result<String, String> {
    let payload = serde_json::json!({
        "message": {
            "subject": args.subject.trim(),
            "body": { "contentType": "Text", "content": args.body },
            "toRecipients": [ { "emailAddress": { "address": args.to.trim() } } ],
        },
        "saveToSentItems": true,
    });
    let client = reqwest::Client::new();
    let res = client.post("https://graph.microsoft.com/v1.0/me/sendMail")
        .header("Authorization", format!("Bearer {}", args.access_token.trim()))
        .json(&payload).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("outlook send {}: {}", status.as_u16(), text.chars().take(240).collect::<String>()));
    }
    Ok("{\"ok\":true}".into())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MsDriveArgs { access_token: String, name: String, #[serde(default)] mime: String, content: String }
// Upload a file to the root of the user's OneDrive. Returns { id, name, webUrl }.
#[tauri::command]
async fn ms_drive_create(args: MsDriveArgs) -> Result<String, String> {
    let mime = if args.mime.trim().is_empty() { "text/plain" } else { args.mime.trim() };
    let name = args.name.trim();
    let url = format!("https://graph.microsoft.com/v1.0/me/drive/root:/{}:/content", urlencode(name));
    let client = reqwest::Client::new();
    let res = client.put(&url)
        .header("Authorization", format!("Bearer {}", args.access_token.trim()))
        .header("Content-Type", mime)
        .body(args.content).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("onedrive {}: {}", status.as_u16(), text.chars().take(240).collect::<String>())); }
    Ok(text)
}

// ============================ Notion (OAuth) ============================
// Sign-in with Notion (public integration). Loopback redirect (Notion allows http://localhost), auth-code
// exchanged with HTTP Basic auth (client_id:client_secret). Notion access tokens don't expire → no refresh.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotionConnectArgs { client_id: String, client_secret: String }

#[tauri::command]
async fn notion_connect(app: AppHandle, args: NotionConnectArgs) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use base64::Engine;
    let cid = args.client_id.trim();
    let csecret = args.client_secret.trim();
    if cid.is_empty() || csecret.is_empty() { return Err("Enter your Notion integration's client ID and secret first".into()); }
    // Notion requires the redirect_uri to EXACTLY match a registered one (no dynamic ports like Google/MS),
    // so we bind a FIXED loopback port. Register http://localhost:53682 in the Notion integration.
    let redirect = "http://localhost:53682".to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:53682").await
        .map_err(|_| "Port 53682 is busy. Close whatever is using it and try Notion again.".to_string())?;
    let auth_url = format!(
        "https://api.notion.com/v1/oauth/authorize?client_id={}&response_type=code&owner=user&redirect_uri={}",
        urlencode(cid), urlencode(&redirect)
    );
    app.opener().open_url(&auth_url, None::<&str>).map_err(|e| e.to_string())?;

    let (mut stream, _) = tokio::time::timeout(std::time::Duration::from_secs(180), listener.accept())
        .await.map_err(|_| "Notion sign-in timed out. Try again.".to_string())?
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 16384];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let first = req.lines().next().unwrap_or("");
    let path = first.split_whitespace().nth(1).unwrap_or("");
    let code = query_param(path, "code").unwrap_or_default();
    let oauth_err = query_param(path, "error");
    let body = "<!doctype html><html><body style='font-family:system-ui;padding:48px;background:#F5EDD8;color:#2C1508'><h2>Keak is connected to Notion.</h2><p>You can close this tab and go back to Keak.</p></body></html>";
    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.flush().await;
    if let Some(e) = oauth_err { return Err(format!("Notion sign-in was denied: {}", e)); }
    if code.is_empty() { return Err("Notion didn't return an authorization code".into()); }

    let basic = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", cid, csecret));
    let client = reqwest::Client::new();
    let res = client.post("https://api.notion.com/v1/oauth/token")
        .header("Authorization", format!("Basic {}", basic))
        .header("Notion-Version", "2022-06-28")
        .json(&serde_json::json!({ "grant_type": "authorization_code", "code": code, "redirect_uri": redirect }))
        .send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("notion token {}: {}", status.as_u16(), text.chars().take(240).collect::<String>())); }
    Ok(text) // { access_token, workspace_name, workspace_id, ... }
}

// Create a Notion page (a quick note) under the given parent page id. Returns the created page JSON (incl. url).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotionPageArgs { access_token: String, parent_page_id: String, title: String, #[serde(default)] content: String }
#[tauri::command]
async fn notion_create_page(args: NotionPageArgs) -> Result<String, String> {
    let mut children = vec![];
    if !args.content.trim().is_empty() {
        children.push(serde_json::json!({
            "object": "block", "type": "paragraph",
            "paragraph": { "rich_text": [ { "type": "text", "text": { "content": args.content } } ] }
        }));
    }
    let body = serde_json::json!({
        "parent": { "page_id": args.parent_page_id.trim() },
        "properties": { "title": { "title": [ { "text": { "content": args.title } } ] } },
        "children": children,
    });
    let client = reqwest::Client::new();
    let res = client.post("https://api.notion.com/v1/pages")
        .header("Authorization", format!("Bearer {}", args.access_token.trim()))
        .header("Notion-Version", "2022-06-28")
        .json(&body).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("notion page {}: {}", status.as_u16(), text.chars().take(240).collect::<String>())); }
    Ok(text)
}

// ============================ Slack (token) ============================
// Slack blocks the http://localhost redirect a desktop loopback needs, so the user pastes a Bot/User OAuth
// token (xoxb-/xoxp-). auth.test validates it; chat.postMessage posts.
// One-click Slack sign-in. Slack forbids http://localhost redirects, so we register an https RELAY page
// (https://keak.app/oauth/slack) that just bounces the browser to http://localhost:53683 with the code.
// The desktop listens on that fixed loopback port and exchanges the code. redirect_uri in BOTH the authorize
// URL and the token exchange must equal the relay URL (Slack validates they match).
const SLACK_RELAY: &str = "https://keak.app/oauth/slack";
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlackConnectArgs { client_id: String, client_secret: String }
#[tauri::command]
async fn slack_connect(app: AppHandle, args: SlackConnectArgs) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let cid = args.client_id.trim();
    let csecret = args.client_secret.trim();
    if cid.is_empty() || csecret.is_empty() { return Err("Enter the Slack client ID and secret first".into()); }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:53683").await
        .map_err(|_| "Port 53683 is busy. Close whatever is using it and try Slack again.".to_string())?;
    let scope = "chat:write,chat:write.public,channels:read";
    let auth_url = format!(
        "https://slack.com/oauth/v2/authorize?client_id={}&scope={}&redirect_uri={}",
        urlencode(cid), urlencode(scope), urlencode(SLACK_RELAY)
    );
    app.opener().open_url(&auth_url, None::<&str>).map_err(|e| e.to_string())?;

    let (mut stream, _) = tokio::time::timeout(std::time::Duration::from_secs(180), listener.accept())
        .await.map_err(|_| "Slack sign-in timed out. Try again.".to_string())?
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 16384];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let first = req.lines().next().unwrap_or("");
    let path = first.split_whitespace().nth(1).unwrap_or("");
    let code = query_param(path, "code").unwrap_or_default();
    let oauth_err = query_param(path, "error");
    let body = "<!doctype html><html><body style='font-family:system-ui;padding:48px;background:#F5EDD8;color:#2C1508'><h2>Keak is connected to Slack.</h2><p>You can close this tab and go back to Keak.</p></body></html>";
    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.flush().await;
    if let Some(e) = oauth_err { return Err(format!("Slack sign-in was denied: {}", e)); }
    if code.is_empty() { return Err("Slack didn't return an authorization code".into()); }

    let client = reqwest::Client::new();
    let res = client.post("https://slack.com/api/oauth.v2.access")
        .form(&[
            ("client_id", cid), ("client_secret", csecret), ("code", code.as_str()),
            ("redirect_uri", SLACK_RELAY),
        ])
        .send().await.map_err(|e| e.to_string())?;
    let text = res.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!({}));
    if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
        return Err(format!("slack: {}", v.get("error").and_then(|e| e.as_str()).unwrap_or("token exchange failed")));
    }
    // Bot token lives in access_token; team name under team.name. Return a shape the frontend can store.
    let bot = v.get("access_token").and_then(|s| s.as_str()).unwrap_or("");
    let team = v.get("team").and_then(|t| t.get("name")).and_then(|s| s.as_str()).unwrap_or("");
    Ok(serde_json::json!({ "token": bot, "team": team }).to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlackTokenArgs { token: String }
#[tauri::command]
async fn slack_test(args: SlackTokenArgs) -> Result<String, String> {
    let client = reqwest::Client::new();
    let res = client.post("https://slack.com/api/auth.test")
        .header("Authorization", format!("Bearer {}", args.token.trim()))
        .send().await.map_err(|e| e.to_string())?;
    let text = res.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!({}));
    if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
        return Err(format!("slack: {}", v.get("error").and_then(|e| e.as_str()).unwrap_or("invalid token")));
    }
    Ok(text) // { ok, team, user, ... }
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlackPostArgs { token: String, channel: String, text: String }
#[tauri::command]
async fn slack_post(args: SlackPostArgs) -> Result<String, String> {
    let client = reqwest::Client::new();
    let res = client.post("https://slack.com/api/chat.postMessage")
        .header("Authorization", format!("Bearer {}", args.token.trim()))
        .json(&serde_json::json!({ "channel": args.channel.trim(), "text": args.text }))
        .send().await.map_err(|e| e.to_string())?;
    let text = res.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!({}));
    if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
        return Err(format!("slack: {}", v.get("error").and_then(|e| e.as_str()).unwrap_or("post failed")));
    }
    Ok(text)
}

// ============================ Perplexity (research) ============================
// Live web research with citations. OpenAI-compatible chat endpoint; the user's own pplx- API key.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PerplexityArgs { api_key: String, query: String, #[serde(default)] model: String }
#[tauri::command]
async fn perplexity_ask(args: PerplexityArgs) -> Result<String, String> {
    let key = args.api_key.trim();
    if key.is_empty() { return Err("Add your Perplexity API key first".into()); }
    let model = if args.model.trim().is_empty() { "sonar" } else { args.model.trim() };
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": "Be concise and accurate. Answer in the user's language." },
            { "role": "user", "content": args.query }
        ]
    });
    let client = reqwest::Client::new();
    let res = client.post("https://api.perplexity.ai/chat/completions")
        .header("Authorization", format!("Bearer {}", key))
        .json(&body).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("perplexity {}: {}", status.as_u16(), text.chars().take(240).collect::<String>())); }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let answer = v.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message"))
        .and_then(|m| m.get("content")).and_then(|s| s.as_str()).unwrap_or("").to_string();
    if answer.is_empty() { return Err("perplexity returned no answer".into()); }
    Ok(answer)
}

// ============================ Tool execution (ElevenLabs / Gamma / HeyGen / webhooks) ============================
// A unique-ish filename in the shared artifacts dir (no rand crate — clock nanos).
fn artifact_path(prefix: &str, ext: &str) -> std::path::PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push("keak-artifacts");
    let _ = std::fs::create_dir_all(&dir);
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    dir.push(format!("{}-{}.{}", prefix, n, ext));
    dir
}

// ElevenLabs text-to-speech → saves an mp3 and returns its path. Default voice = Rachel.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ElevenArgs { api_key: String, text: String, #[serde(default)] voice_id: String }
#[tauri::command]
async fn elevenlabs_tts(args: ElevenArgs) -> Result<String, String> {
    let key = args.api_key.trim();
    if key.is_empty() { return Err("Add your ElevenLabs API key first".into()); }
    let voice = if args.voice_id.trim().is_empty() { "21m00Tcm4TlvDq8ikWAM" } else { args.voice_id.trim() };
    let url = format!("https://api.elevenlabs.io/v1/text-to-speech/{}?output_format=mp3_44100_128", voice);
    let client = reqwest::Client::new();
    let res = client.post(&url)
        .header("xi-api-key", key)
        .header("accept", "audio/mpeg")
        .json(&serde_json::json!({ "text": args.text, "model_id": "eleven_multilingual_v2" }))
        .send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let t = res.text().await.unwrap_or_default();
        return Err(format!("elevenlabs {}: {}", status.as_u16(), t.chars().take(200).collect::<String>()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let path = artifact_path("voiceover", "mp3");
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// Same as elevenlabs_tts but returns base64 MP3 for inline playback (Keak's spoken voice + preview), instead
// of writing a file artifact.
#[tauri::command]
async fn elevenlabs_speak(args: ElevenArgs) -> Result<String, String> {
    use base64::Engine;
    let key = args.api_key.trim();
    if key.is_empty() { return Err("Add your ElevenLabs API key first".into()); }
    let voice = if args.voice_id.trim().is_empty() { "21m00Tcm4TlvDq8ikWAM" } else { args.voice_id.trim() };
    let url = format!("https://api.elevenlabs.io/v1/text-to-speech/{}?output_format=mp3_44100_128", voice);
    let client = reqwest::Client::new();
    let res = client.post(&url)
        .header("xi-api-key", key)
        .header("accept", "audio/mpeg")
        .json(&serde_json::json!({ "text": args.text, "model_id": "eleven_multilingual_v2" }))
        .send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let t = res.text().await.unwrap_or_default();
        return Err(format!("elevenlabs {}: {}", status.as_u16(), t.chars().take(200).collect::<String>()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

// Gamma: create a deck from a prompt, poll until ready, return the gamma URL.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GammaArgs { api_key: String, prompt: String }
#[tauri::command]
async fn gamma_generate(args: GammaArgs) -> Result<String, String> {
    let key = args.api_key.trim();
    if key.is_empty() { return Err("Add your Gamma API key first".into()); }
    let client = reqwest::Client::new();
    let create = client.post("https://public-api.gamma.app/v0.2/generations")
        .header("X-API-KEY", key)
        .json(&serde_json::json!({ "inputText": args.prompt, "format": "presentation", "textMode": "generate" }))
        .send().await.map_err(|e| e.to_string())?;
    let cs = create.status();
    let ct = create.text().await.map_err(|e| e.to_string())?;
    if !cs.is_success() { return Err(format!("gamma {}: {}", cs.as_u16(), ct.chars().take(200).collect::<String>())); }
    let cv: serde_json::Value = serde_json::from_str(&ct).map_err(|e| e.to_string())?;
    let id = cv.get("generationId").and_then(|s| s.as_str()).unwrap_or("").to_string();
    if id.is_empty() { return Err("gamma returned no generation id".into()); }
    // Poll up to ~2 min.
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let g = client.get(format!("https://public-api.gamma.app/v0.2/generations/{}", id))
            .header("X-API-KEY", key).send().await.map_err(|e| e.to_string())?;
        let gt = g.text().await.map_err(|e| e.to_string())?;
        let gv: serde_json::Value = serde_json::from_str(&gt).unwrap_or(serde_json::json!({}));
        let st = gv.get("status").and_then(|s| s.as_str()).unwrap_or("");
        if st == "completed" {
            if let Some(u) = gv.get("gammaUrl").and_then(|s| s.as_str()) { return Ok(u.to_string()); }
        }
        if st == "failed" { return Err("gamma generation failed".into()); }
    }
    Err("gamma is still generating, check your Gamma dashboard".into())
}

// HeyGen: generate an avatar video from a script, poll until done, return the video URL.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeyGenArgs { api_key: String, script: String, #[serde(default)] avatar_id: String, #[serde(default)] voice_id: String }
#[tauri::command]
async fn heygen_video(args: HeyGenArgs) -> Result<String, String> {
    let key = args.api_key.trim();
    if key.is_empty() { return Err("Add your HeyGen API key first".into()); }
    let avatar = if args.avatar_id.trim().is_empty() { "Daisy-inskirt-20220818" } else { args.avatar_id.trim() };
    let voice = if args.voice_id.trim().is_empty() { "2d5b0e6cf36f460aa7fc47e3eee4ba54" } else { args.voice_id.trim() };
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "video_inputs": [ {
            "character": { "type": "avatar", "avatar_id": avatar, "avatar_style": "normal" },
            "voice": { "type": "text", "input_text": args.script, "voice_id": voice }
        } ],
        "dimension": { "width": 1280, "height": 720 }
    });
    let create = client.post("https://api.heygen.com/v2/video/generate")
        .header("X-Api-Key", key).json(&body).send().await.map_err(|e| e.to_string())?;
    let cs = create.status();
    let ct = create.text().await.map_err(|e| e.to_string())?;
    if !cs.is_success() { return Err(format!("heygen {}: {}", cs.as_u16(), ct.chars().take(220).collect::<String>())); }
    let cv: serde_json::Value = serde_json::from_str(&ct).map_err(|e| e.to_string())?;
    let vid = cv.get("data").and_then(|d| d.get("video_id")).and_then(|s| s.as_str()).unwrap_or("").to_string();
    if vid.is_empty() { return Err("heygen returned no video id".into()); }
    // Poll up to ~3 min.
    for _ in 0..45 {
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        let s = client.get(format!("https://api.heygen.com/v1/video_status.get?video_id={}", vid))
            .header("X-Api-Key", key).send().await.map_err(|e| e.to_string())?;
        let stt = s.text().await.map_err(|e| e.to_string())?;
        let sv: serde_json::Value = serde_json::from_str(&stt).unwrap_or(serde_json::json!({}));
        let status = sv.get("data").and_then(|d| d.get("status")).and_then(|s| s.as_str()).unwrap_or("");
        if status == "completed" {
            if let Some(u) = sv.get("data").and_then(|d| d.get("video_url")).and_then(|s| s.as_str()) { return Ok(u.to_string()); }
        }
        if status == "failed" { return Err("heygen video failed to render".into()); }
    }
    Err("heygen is still rendering, it'll appear in your HeyGen library shortly".into())
}

// List the user's HeyGen avatars + voices so they can pick which to use. Returns
// { avatars: [{id,name}], voices: [{id,name,language}] } (capped).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeyGenKeyArgs { api_key: String }
#[tauri::command]
async fn heygen_assets(args: HeyGenKeyArgs) -> Result<String, String> {
    let key = args.api_key.trim();
    if key.is_empty() { return Err("Add your HeyGen API key first".into()); }
    let client = reqwest::Client::new();
    // Avatars
    let ar = client.get("https://api.heygen.com/v2/avatars").header("X-Api-Key", key)
        .send().await.map_err(|e| e.to_string())?;
    let at = ar.text().await.map_err(|e| e.to_string())?;
    let av: serde_json::Value = serde_json::from_str(&at).unwrap_or(serde_json::json!({}));
    let mut avatars: Vec<serde_json::Value> = Vec::new();
    if let Some(arr) = av.get("data").and_then(|d| d.get("avatars")).and_then(|a| a.as_array()) {
        for a in arr.iter().take(100) {
            let id = a.get("avatar_id").and_then(|s| s.as_str()).unwrap_or("");
            let name = a.get("avatar_name").and_then(|s| s.as_str()).unwrap_or(id);
            if !id.is_empty() { avatars.push(serde_json::json!({ "id": id, "name": name })); }
        }
    }
    // Voices
    let vr = client.get("https://api.heygen.com/v2/voices").header("X-Api-Key", key)
        .send().await.map_err(|e| e.to_string())?;
    let vt = vr.text().await.map_err(|e| e.to_string())?;
    let vv: serde_json::Value = serde_json::from_str(&vt).unwrap_or(serde_json::json!({}));
    let mut voices: Vec<serde_json::Value> = Vec::new();
    if let Some(arr) = vv.get("data").and_then(|d| d.get("voices")).and_then(|a| a.as_array()) {
        for v in arr.iter().take(150) {
            let id = v.get("voice_id").and_then(|s| s.as_str()).unwrap_or("");
            let name = v.get("name").and_then(|s| s.as_str()).unwrap_or(id);
            let lang = v.get("language").and_then(|s| s.as_str()).unwrap_or("");
            if !id.is_empty() { voices.push(serde_json::json!({ "id": id, "name": name, "language": lang })); }
        }
    }
    if avatars.is_empty() && voices.is_empty() {
        return Err("HeyGen returned no avatars or voices (check the API key)".into());
    }
    Ok(serde_json::json!({ "avatars": avatars, "voices": voices }).to_string())
}

// Fire a webhook (n8n Catch Hook, Zapier Catch Hook, or any workflow URL) with a JSON payload.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebhookArgs { url: String, text: String }
#[tauri::command]
async fn webhook_post(args: WebhookArgs) -> Result<String, String> {
    let url = args.url.trim();
    if !url.starts_with("http") { return Err("That doesn't look like a webhook URL".into()); }
    let client = reqwest::Client::new();
    let res = client.post(url)
        .json(&serde_json::json!({ "text": args.text, "source": "keak" }))
        .send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let t = res.text().await.unwrap_or_default();
        return Err(format!("webhook {}: {}", status.as_u16(), t.chars().take(160).collect::<String>()));
    }
    Ok("{\"ok\":true}".into())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MakeArgs { token: String, region: String, #[serde(default)] scenario_id: String }

// List the user's Make scenarios (across their organizations) so they can pick which one Keak runs.
#[tauri::command]
async fn make_scenarios(args: MakeArgs) -> Result<String, String> {
    let region = args.region.trim();
    let token = args.token.trim();
    if token.is_empty() || region.is_empty() { return Err("Add your Make API token and region first".into()); }
    let base = format!("https://{}.make.com/api/v2", region);
    let client = reqwest::Client::new();
    let auth = format!("Token {}", token);
    let orgs: serde_json::Value = client.get(format!("{}/organizations", base))
        .header("Authorization", &auth).send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| format!("Make: bad token or region ({})", e))?;
    let mut out: Vec<serde_json::Value> = Vec::new();
    if let Some(arr) = orgs.get("organizations").and_then(|v| v.as_array()) {
        for org in arr {
            let Some(oid) = org.get("id") else { continue };
            let sc: serde_json::Value = match client.get(format!("{}/scenarios?organizationId={}", base, oid))
                .header("Authorization", &auth).send().await {
                Ok(r) => r.json().await.unwrap_or(serde_json::json!({})),
                Err(_) => continue,
            };
            if let Some(list) = sc.get("scenarios").and_then(|v| v.as_array()) {
                for s in list {
                    let id = match s.get("id") {
                        Some(serde_json::Value::Number(n)) => n.to_string(),
                        Some(serde_json::Value::String(x)) => x.clone(),
                        _ => continue,
                    };
                    let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("Scenario");
                    out.push(serde_json::json!({ "id": id, "name": name }));
                }
            }
        }
    }
    if out.is_empty() { return Err("No scenarios found. Check the token and region.".into()); }
    Ok(serde_json::json!({ "scenarios": out }).to_string())
}

// Run a Make scenario now (used by the automation trigger).
#[tauri::command]
async fn make_run(args: MakeArgs) -> Result<String, String> {
    let region = args.region.trim();
    let token = args.token.trim();
    let sid = args.scenario_id.trim();
    if token.is_empty() || region.is_empty() || sid.is_empty() { return Err("Make token, region, and scenario are required".into()); }
    let res = reqwest::Client::new()
        .post(format!("https://{}.make.com/api/v2/scenarios/{}/run", region, sid))
        .header("Authorization", format!("Token {}", token))
        .header("Content-Type", "application/json")
        .body("{}").send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() { return Err(format!("make {}: {}", status.as_u16(), text.chars().take(200).collect::<String>())); }
    Ok("{\"ok\":true}".into())
}

// Manus: hand a whole task to the autonomous agent. It runs async in Manus cloud; return the task URL to open.
// POST https://api.manus.ai/v2/task.create, header x-manus-api-key.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManusArgs { api_key: String, prompt: String }
#[tauri::command]
async fn manus_task(args: ManusArgs) -> Result<String, String> {
    let key = args.api_key.trim();
    if key.is_empty() { return Err("Add your Manus API key first".into()); }
    let body = serde_json::json!({
        "message": { "content": [ { "type": "text", "text": args.prompt } ] }
    });
    let client = reqwest::Client::new();
    let res = client.post("https://api.manus.ai/v2/task.create")
        .header("x-manus-api-key", key)
        .json(&body).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("manus {}: {}", status.as_u16(), text.chars().take(220).collect::<String>())); }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let url = v.get("task_url").and_then(|s| s.as_str()).unwrap_or("").to_string();
    if url.is_empty() { return Err("manus returned no task URL".into()); }
    Ok(url)
}

// Higgsfield: cinematic AI image/video from a prompt. POST /v1/generations (Bearer), then poll the returned
// status_url until it's done, and dig the result asset URL out of the response.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HiggsfieldArgs { api_key: String, prompt: String }
fn find_media_url(v: &serde_json::Value) -> Option<String> {
    // Look for a plausible result URL under common field names / arrays.
    for k in ["url", "result_url", "output_url", "video_url", "image_url", "output"] {
        if let Some(s) = v.get(k).and_then(|x| x.as_str()) { if s.starts_with("http") { return Some(s.to_string()); } }
    }
    for k in ["assets", "results", "outputs", "images", "videos"] {
        if let Some(arr) = v.get(k).and_then(|x| x.as_array()) {
            for it in arr {
                if let Some(s) = it.as_str() { if s.starts_with("http") { return Some(s.to_string()); } }
                if let Some(u) = find_media_url(it) { return Some(u); }
            }
        }
    }
    if let Some(obj) = v.get("result") { return find_media_url(obj); }
    None
}
#[tauri::command]
async fn higgsfield_generate(args: HiggsfieldArgs) -> Result<String, String> {
    let key = args.api_key.trim();
    if key.is_empty() { return Err("Add your Higgsfield API key first".into()); }
    let client = reqwest::Client::new();
    let create = client.post("https://platform.higgsfield.ai/v1/generations")
        .header("Authorization", format!("Bearer {}", key))
        .json(&serde_json::json!({ "prompt": args.prompt }))
        .send().await.map_err(|e| e.to_string())?;
    let cs = create.status();
    let ct = create.text().await.map_err(|e| e.to_string())?;
    if !cs.is_success() { return Err(format!("higgsfield {}: {}", cs.as_u16(), ct.chars().take(220).collect::<String>())); }
    let cv: serde_json::Value = serde_json::from_str(&ct).map_err(|e| e.to_string())?;
    // Some responses already carry the asset; otherwise poll status_url.
    if let Some(u) = find_media_url(&cv) { return Ok(u); }
    let status_url = cv.get("status_url").and_then(|s| s.as_str()).unwrap_or("").to_string();
    if status_url.is_empty() { return Err("higgsfield returned no status URL".into()); }
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let s = client.get(&status_url).header("Authorization", format!("Bearer {}", key))
            .send().await.map_err(|e| e.to_string())?;
        let st = s.text().await.map_err(|e| e.to_string())?;
        let sv: serde_json::Value = serde_json::from_str(&st).unwrap_or(serde_json::json!({}));
        let state = sv.get("status").and_then(|x| x.as_str()).unwrap_or("");
        if let Some(u) = find_media_url(&sv) { return Ok(u); }
        if state == "failed" || state == "error" { return Err("higgsfield generation failed".into()); }
    }
    Err("higgsfield is still generating, check your Higgsfield dashboard".into())
}

// ============================ Figma (OAuth) ============================
// Sign-in with Figma. Loopback fixed port 53684 (register http://localhost:53684/callback in the Figma app).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FigmaConnectArgs { client_id: String, client_secret: String }
#[tauri::command]
async fn figma_connect(app: AppHandle, args: FigmaConnectArgs) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let cid = args.client_id.trim();
    let csecret = args.client_secret.trim();
    if cid.is_empty() || csecret.is_empty() { return Err("Enter your Figma client ID and secret first".into()); }
    let redirect = "http://localhost:53684/callback".to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:53684").await
        .map_err(|_| "Port 53684 is busy. Close whatever is using it and try Figma again.".to_string())?;
    let auth_url = format!(
        "https://www.figma.com/oauth?client_id={}&redirect_uri={}&scope=file_read&state=keak&response_type=code",
        urlencode(cid), urlencode(&redirect)
    );
    app.opener().open_url(&auth_url, None::<&str>).map_err(|e| e.to_string())?;

    let (mut stream, _) = tokio::time::timeout(std::time::Duration::from_secs(180), listener.accept())
        .await.map_err(|_| "Figma sign-in timed out. Try again.".to_string())?
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 16384];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let first = req.lines().next().unwrap_or("");
    let path = first.split_whitespace().nth(1).unwrap_or("");
    let code = query_param(path, "code").unwrap_or_default();
    let oauth_err = query_param(path, "error");
    let body = "<!doctype html><html><body style='font-family:system-ui;padding:48px;background:#F5EDD8;color:#2C1508'><h2>Keak is connected to Figma.</h2><p>You can close this tab and go back to Keak.</p></body></html>";
    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.flush().await;
    if let Some(e) = oauth_err { return Err(format!("Figma sign-in was denied: {}", e)); }
    if code.is_empty() { return Err("Figma didn't return an authorization code".into()); }

    let client = reqwest::Client::new();
    let res = client.post("https://api.figma.com/v1/oauth/token")
        .form(&[
            ("client_id", cid), ("client_secret", csecret), ("redirect_uri", redirect.as_str()),
            ("code", code.as_str()), ("grant_type", "authorization_code"),
        ])
        .send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("figma token {}: {}", status.as_u16(), text.chars().take(220).collect::<String>())); }
    Ok(text) // { access_token, refresh_token, expires_in, ... }
}

// ============================ Resend (send email) ============================
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResendArgs { api_key: String, #[serde(default)] from: String, to: String, subject: String, body: String }
#[tauri::command]
async fn resend_send(args: ResendArgs) -> Result<String, String> {
    let key = args.api_key.trim();
    if key.is_empty() { return Err("Add your Resend API key first".into()); }
    // Default sender only reaches your own account email until you verify a domain in Resend.
    let from = if args.from.trim().is_empty() { "Keak <onboarding@resend.dev>" } else { args.from.trim() };
    let payload = serde_json::json!({
        "from": from, "to": [ args.to.trim() ], "subject": args.subject.trim(), "text": args.body
    });
    let client = reqwest::Client::new();
    let res = client.post("https://api.resend.com/emails")
        .header("Authorization", format!("Bearer {}", key))
        .json(&payload).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("resend {}: {}", status.as_u16(), text.chars().take(220).collect::<String>())); }
    Ok(text)
}

// ============================ Generic "do anything" executors ============================
// The user's own AI translates a natural request into one of these calls; Keak runs it with the stored creds.

// Supabase PostgREST: run any table CRUD. path is relative to /rest/v1/ (e.g. "users?select=*&id=eq.3").
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupabaseRestArgs { url: String, key: String, method: String, path: String, #[serde(default)] body: String }
#[tauri::command]
async fn supabase_rest(args: SupabaseRestArgs) -> Result<String, String> {
    let base = args.url.trim().trim_end_matches('/');
    let key = args.key.trim();
    if base.is_empty() || key.is_empty() { return Err("Connect Supabase first (project URL + service key)".into()); }
    let full = format!("{}/rest/v1/{}", base, args.path.trim().trim_start_matches('/'));
    let client = reqwest::Client::new();
    let method = args.method.trim().to_uppercase();
    let mut rb = match method.as_str() {
        "GET" => client.get(&full),
        "POST" => client.post(&full),
        "PATCH" => client.patch(&full),
        "DELETE" => client.delete(&full),
        "PUT" => client.put(&full),
        _ => return Err(format!("unsupported method {}", method)),
    };
    rb = rb.header("apikey", key)
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .header("Prefer", "return=representation");
    if !args.body.trim().is_empty() && method != "GET" && method != "DELETE" {
        rb = rb.body(args.body.clone());
    }
    let res = rb.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("supabase {}: {}", status.as_u16(), text.chars().take(260).collect::<String>())); }
    Ok(if text.trim().is_empty() { "{\"ok\":true}".into() } else { text })
}

// Supabase schema: compact {table: [columns]} from the PostgREST OpenAPI, so the AI can build correct calls.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupabaseSchemaArgs { url: String, key: String }
#[tauri::command]
async fn supabase_schema(args: SupabaseSchemaArgs) -> Result<String, String> {
    let base = args.url.trim().trim_end_matches('/');
    let key = args.key.trim();
    if base.is_empty() || key.is_empty() { return Err("Connect Supabase first".into()); }
    let client = reqwest::Client::new();
    let res = client.get(format!("{}/rest/v1/", base))
        .header("apikey", key).header("Authorization", format!("Bearer {}", key))
        .header("Accept", "application/openapi+json")
        .send().await.map_err(|e| e.to_string())?;
    let text = res.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!({}));
    let mut out = serde_json::Map::new();
    if let Some(defs) = v.get("definitions").and_then(|d| d.as_object()) {
        for (table, def) in defs.iter().take(60) {
            if let Some(props) = def.get("properties").and_then(|p| p.as_object()) {
                let cols: Vec<String> = props.keys().take(40).cloned().collect();
                out.insert(table.clone(), serde_json::json!(cols));
            }
        }
    }
    Ok(serde_json::to_string(&out).unwrap_or_else(|_| "{}".into()))
}

// Figma REST: run any Figma API call (mostly read + comments). path like "/v1/files/KEY" or "/v1/me".
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FigmaApiArgs { token: String, method: String, path: String, #[serde(default)] body: String }
#[tauri::command]
async fn figma_api(args: FigmaApiArgs) -> Result<String, String> {
    let token = args.token.trim();
    if token.is_empty() { return Err("Connect Figma first".into()); }
    let full = format!("https://api.figma.com{}", args.path.trim());
    let client = reqwest::Client::new();
    let method = args.method.trim().to_uppercase();
    let mut rb = match method.as_str() {
        "GET" => client.get(&full),
        "POST" => client.post(&full),
        "PUT" => client.put(&full),
        "DELETE" => client.delete(&full),
        _ => return Err(format!("unsupported method {}", method)),
    };
    rb = rb.header("Authorization", format!("Bearer {}", token)).header("Content-Type", "application/json");
    if !args.body.trim().is_empty() && method != "GET" { rb = rb.body(args.body.clone()); }
    let res = rb.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("figma {}: {}", status.as_u16(), text.chars().take(260).collect::<String>())); }
    Ok(text)
}

// ============================ GitHub (device flow + do anything) ============================
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhStartArgs { client_id: String }
#[tauri::command]
async fn github_device_start(args: GhStartArgs) -> Result<String, String> {
    let cid = args.client_id.trim();
    if cid.is_empty() { return Err("No GitHub client ID set".into()); }
    let client = reqwest::Client::new();
    let res = client.post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", cid), ("scope", "repo gist read:user workflow")])
        .send().await.map_err(|e| e.to_string())?;
    let text = res.text().await.map_err(|e| e.to_string())?;
    Ok(text) // { device_code, user_code, verification_uri, interval, expires_in }
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPollArgs { client_id: String, device_code: String }
#[tauri::command]
async fn github_device_poll(args: GhPollArgs) -> Result<String, String> {
    let client = reqwest::Client::new();
    let res = client.post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", args.client_id.trim()), ("device_code", args.device_code.trim()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send().await.map_err(|e| e.to_string())?;
    let text = res.text().await.map_err(|e| e.to_string())?;
    Ok(text) // { access_token } or { error: "authorization_pending" }
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubApiArgs { token: String, method: String, path: String, #[serde(default)] body: String }
#[tauri::command]
async fn github_api(args: GithubApiArgs) -> Result<String, String> {
    let token = args.token.trim();
    if token.is_empty() { return Err("Connect GitHub first".into()); }
    let p = args.path.trim();
    let full = if p.starts_with("http") { p.to_string() } else { format!("https://api.github.com{}", p) };
    let client = reqwest::Client::new();
    let method = args.method.trim().to_uppercase();
    let mut rb = match method.as_str() {
        "GET" => client.get(&full), "POST" => client.post(&full), "PATCH" => client.patch(&full),
        "PUT" => client.put(&full), "DELETE" => client.delete(&full),
        _ => return Err(format!("unsupported method {}", method)),
    };
    rb = rb.header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Keak")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if !args.body.trim().is_empty() && method != "GET" { rb = rb.body(args.body.clone()).header("Content-Type", "application/json"); }
    let res = rb.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("github {}: {}", status.as_u16(), text.chars().take(240).collect::<String>())); }
    Ok(if text.trim().is_empty() { "{\"ok\":true}".into() } else { text })
}

// ============================ Shopify (store token + do anything) ============================
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShopifyArgs { shop: String, token: String, method: String, path: String, #[serde(default)] body: String }
#[tauri::command]
async fn shopify_api(args: ShopifyArgs) -> Result<String, String> {
    let shop = args.shop.trim().trim_end_matches('/');
    let token = args.token.trim();
    if shop.is_empty() || token.is_empty() { return Err("Connect Shopify first (store domain + Admin token)".into()); }
    let host = if shop.starts_with("http") { shop.to_string() } else { format!("https://{}", shop) };
    let full = format!("{}/admin/api/2024-10/{}", host, args.path.trim().trim_start_matches('/'));
    let client = reqwest::Client::new();
    let method = args.method.trim().to_uppercase();
    let mut rb = match method.as_str() {
        "GET" => client.get(&full), "POST" => client.post(&full), "PUT" => client.put(&full), "DELETE" => client.delete(&full),
        _ => return Err(format!("unsupported method {}", method)),
    };
    rb = rb.header("X-Shopify-Access-Token", token).header("Content-Type", "application/json");
    if !args.body.trim().is_empty() && method != "GET" && method != "DELETE" { rb = rb.body(args.body.clone()); }
    let res = rb.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("shopify {}: {}", status.as_u16(), text.chars().take(240).collect::<String>())); }
    Ok(if text.trim().is_empty() { "{\"ok\":true}".into() } else { text })
}

// ============================ Gumloop (start a flow) ============================
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GumloopArgs { api_key: String, user_id: String, saved_item_id: String, #[serde(default)] inputs: String }
#[tauri::command]
async fn gumloop_start(args: GumloopArgs) -> Result<String, String> {
    let key = args.api_key.trim();
    if key.is_empty() { return Err("Add your Gumloop API key first".into()); }
    let inputs: serde_json::Value = serde_json::from_str(&args.inputs).unwrap_or(serde_json::json!({}));
    let body = serde_json::json!({ "user_id": args.user_id.trim(), "saved_item_id": args.saved_item_id.trim(), "pipeline_inputs": inputs });
    let client = reqwest::Client::new();
    let res = client.post("https://api.gumloop.com/api/v1/start_pipeline")
        .header("Authorization", format!("Bearer {}", key))
        .json(&body).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("gumloop {}: {}", status.as_u16(), text.chars().take(200).collect::<String>())); }
    Ok(text)
}

// ============================ Telegram (phone bridge) ============================
// The desktop long-polls Telegram; the frontend answers each message and replies via sendMessage.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TgPollArgs { token: String, #[serde(default)] offset: i64 }
#[tauri::command]
async fn telegram_poll(args: TgPollArgs) -> Result<String, String> {
    let token = args.token.trim();
    if token.is_empty() { return Err("no telegram token".into()); }
    let url = format!("https://api.telegram.org/bot{}/getUpdates?timeout=0&offset={}", token, args.offset);
    let res = reqwest::Client::new().get(&url).send().await.map_err(|e| e.to_string())?;
    let text = res.text().await.map_err(|e| e.to_string())?;
    Ok(text)
}
// Download a Telegram voice note (getFile -> download the OGG bytes) and return it base64 so the frontend
// can transcribe it like any other audio. Done in Rust because api.telegram.org has no CORS for the WebView.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TgFileArgs { token: String, file_id: String }
#[tauri::command]
async fn telegram_get_voice(args: TgFileArgs) -> Result<String, String> {
    use base64::Engine;
    let token = args.token.trim();
    if token.is_empty() { return Err("no telegram token".into()); }
    let client = reqwest::Client::new();
    let meta = client.get(format!("https://api.telegram.org/bot{}/getFile?file_id={}", token, args.file_id.trim()))
        .send().await.map_err(|e| e.to_string())?
        .text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
    let file_path = v.get("result").and_then(|r| r.get("file_path")).and_then(|p| p.as_str())
        .ok_or("Telegram getFile returned no file_path")?;
    let bytes = client.get(format!("https://api.telegram.org/file/bot{}/{}", token, file_path))
        .send().await.map_err(|e| e.to_string())?
        .bytes().await.map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TgSendArgs { token: String, chat_id: String, text: String }
#[tauri::command]
async fn telegram_send(args: TgSendArgs) -> Result<String, String> {
    let token = args.token.trim();
    let res = reqwest::Client::new()
        .post(format!("https://api.telegram.org/bot{}/sendMessage", token))
        .json(&serde_json::json!({ "chat_id": args.chat_id.trim(), "text": args.text }))
        .send().await.map_err(|e| e.to_string())?;
    let text = res.text().await.map_err(|e| e.to_string())?;
    Ok(text)
}

// Set the bot's OWN profile picture to the Keak logo, so a freshly created Keak bot shows the brand instead
// of a blank avatar. Best-effort: called right after the user connects their token; if Telegram rejects it
// the connect still succeeds (the user can always set it via BotFather). Hand-rolled multipart/form-data
// because reqwest's `multipart` feature isn't enabled. The jpg is embedded at compile time.
#[tauri::command]
async fn telegram_set_photo(token: String) -> Result<String, String> {
    const PHOTO: &[u8] = include_bytes!("../keak-bot-photo.jpg");
    let boundary = "----keakbotphoto7f3a9c2e";
    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(
        format!("--{b}\r\nContent-Disposition: form-data; name=\"photo\"\r\n\r\n{{\"type\":\"static\",\"photo\":\"attach://pic\"}}\r\n", b = boundary).as_bytes(),
    );
    body.extend_from_slice(
        format!("--{b}\r\nContent-Disposition: form-data; name=\"pic\"; filename=\"keak.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n", b = boundary).as_bytes(),
    );
    body.extend_from_slice(PHOTO);
    body.extend_from_slice(format!("\r\n--{b}--\r\n", b = boundary).as_bytes());
    let res = reqwest::Client::new()
        .post(format!("https://api.telegram.org/bot{}/setMyProfilePhoto", token.trim()))
        .header("Content-Type", format!("multipart/form-data; boundary={}", boundary))
        .body(body)
        .send().await.map_err(|e| e.to_string())?;
    let text = res.text().await.map_err(|e| e.to_string())?;
    Ok(text)
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

// The agents overlay is a fullscreen, transparent, CLICK-THROUGH window: named "star" orbs drift across
// the whole screen while sub-agents work, without ever blocking the user's clicks. Size it to the primary
// monitor and turn on ignore-cursor-events every time we show it (a monitor/DPI change could invalidate it).
#[tauri::command]
fn show_agents(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("agents") {
        if let Ok(Some(mon)) = w.primary_monitor() {
            let pos = mon.position();
            let size = mon.size();
            let _ = w.set_position(tauri::PhysicalPosition { x: pos.x, y: pos.y });
            let _ = w.set_size(tauri::PhysicalSize { width: size.width, height: size.height });
        }
        // CLICK-THROUGH: the agents overlay must never block the user's clicks (a fullscreen interactive
        // window froze the whole desktop). Names are shown as always-on labels instead of on hover.
        let _ = w.set_ignore_cursor_events(true);
        let _ = w.set_always_on_top(true);
        w.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_agents(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("agents") {
        let _ = w.hide();
    }
    Ok(())
}

// Save an agent's built artifact (an HTML page, a note, a plan) to a temp file so the "See it" button can
// open the real thing in the browser/editor. Returns the absolute path.
#[tauri::command]
fn save_artifact(name: String, content: String) -> Result<String, String> {
    use std::io::Write;
    let mut dir = std::env::temp_dir();
    dir.push("keak-artifacts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    let safe = if safe.trim_matches('-').is_empty() { "artifact.txt".to_string() } else { safe };
    dir.push(safe);
    let mut f = std::fs::File::create(&dir).map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

// ============================ MCP (Model Context Protocol) ============================
// Keak speaks JSON-RPC 2.0 to MCP servers so ANY MCP tool (Notion, filesystem, GitHub, a company's own server…)
// becomes usable by the chat agent. Two transports: "local" spawns a stdio server (e.g. `npx -y <server>`),
// "remote" POSTs to an HTTP (Streamable HTTP) endpoint. For robustness we run the full handshake per call
// (initialize -> notifications/initialized -> the method) and, for local, spawn a fresh process per call.
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct McpServer {
    #[serde(default)] transport: String,                                    // "local" | "remote"
    #[serde(default)] command: String,                                      // local: program (e.g. "npx")
    #[serde(default)] args: Vec<String>,                                    // local: program args
    #[serde(default)] url: String,                                          // remote: endpoint URL
    #[serde(default)] headers: std::collections::HashMap<String, String>,   // remote: auth headers
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpCallArgs {
    server: McpServer,
    method: String,                                                         // "tools/list" | "tools/call"
    #[serde(default)] params: serde_json::Value,
}
// Pull the JSON-RPC result out of a body that is raw JSON OR an SSE stream (`data: {...}` lines).
fn mcp_extract(text: &str) -> Result<serde_json::Value, String> {
    let trimmed = text.trim();
    let json_str = if trimmed.starts_with('{') {
        trimmed.to_string()
    } else {
        let mut last = String::new();
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("data:") {
                let r = rest.trim();
                if r.starts_with('{') { last = r.to_string(); }
            }
        }
        if last.is_empty() { return Err(format!("MCP returned no JSON ({})", trimmed.chars().take(160).collect::<String>())); }
        last
    };
    let v: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| format!("MCP parse error: {}", e))?;
    if let Some(err) = v.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).map(|s| s.to_string()).unwrap_or_else(|| err.to_string());
        return Err(format!("MCP error: {}", msg));
    }
    Ok(v.get("result").cloned().unwrap_or(v))
}
async fn mcp_remote(s: &McpServer, method: &str, params: &serde_json::Value) -> Result<String, String> {
    if s.url.trim().is_empty() { return Err("This MCP server has no URL.".into()); }
    let client = reqwest::Client::new();
    let build = |body: serde_json::Value, session: Option<String>| {
        let mut req = client.post(s.url.trim())
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream");
        for (k, v) in &s.headers { req = req.header(k.as_str(), v.as_str()); }
        if let Some(sid) = session { req = req.header("Mcp-Session-Id", sid); }
        req.json(&body).send()
    };
    // 1) initialize (also yields the session id many servers require on later calls)
    let init = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"Keak","version":"1.0"}}});
    let res = build(init, None).await.map_err(|e| e.to_string())?;
    let session = res.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(|x| x.to_string());
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("MCP {}: {}", status.as_u16(), body.chars().take(200).collect::<String>())); }
    let _ = mcp_extract(&body)?;
    // 2) initialized notification (best-effort)
    let note = serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"});
    let _ = build(note, session.clone()).await;
    // 3) the actual call
    let call = serde_json::json!({"jsonrpc":"2.0","id":2,"method":method,"params":params});
    let res3 = build(call, session).await.map_err(|e| e.to_string())?;
    let status3 = res3.status();
    let body3 = res3.text().await.map_err(|e| e.to_string())?;
    if !status3.is_success() { return Err(format!("MCP {}: {}", status3.as_u16(), body3.chars().take(200).collect::<String>())); }
    let result = mcp_extract(&body3)?;
    serde_json::to_string(&result).map_err(|e| e.to_string())
}
async fn mcp_read_result(
    reader: &mut tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    id: i64,
) -> Result<serde_json::Value, String> {
    use tokio::io::AsyncBufReadExt;
    use tokio::time::{timeout, Duration};
    loop {
        let line = timeout(Duration::from_secs(45), reader.next_line())
            .await.map_err(|_| "MCP server timed out.".to_string())?
            .map_err(|e| e.to_string())?;
        let Some(line) = line else { return Err("MCP server closed the connection.".into()); };
        if line.trim().is_empty() { continue; }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
        if v.get("id").and_then(|x| x.as_i64()) == Some(id) {
            if let Some(err) = v.get("error") {
                let msg = err.get("message").and_then(|m| m.as_str()).map(|s| s.to_string()).unwrap_or_else(|| err.to_string());
                return Err(format!("MCP error: {}", msg));
            }
            return Ok(v.get("result").cloned().unwrap_or(v));
        }
    }
}
async fn mcp_local(s: &McpServer, method: &str, params: &serde_json::Value) -> Result<String, String> {
    use tokio::io::{AsyncWriteExt, AsyncBufReadExt, BufReader};
    if s.command.trim().is_empty() { return Err("This MCP server has no command.".into()); }
    // On Windows npx/npm are .cmd shims that CreateProcess can't launch directly, so route them through cmd.exe.
    #[cfg(windows)]
    let (program, prog_args): (String, Vec<String>) = {
        if s.command.to_lowercase().ends_with(".exe") { (s.command.trim().to_string(), s.args.clone()) }
        else { let mut a = vec!["/c".to_string(), s.command.trim().to_string()]; a.extend(s.args.clone()); ("cmd".to_string(), a) }
    };
    #[cfg(not(windows))]
    let (program, prog_args): (String, Vec<String>) = (s.command.trim().to_string(), s.args.clone());
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&prog_args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); } // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start MCP server '{}': {}", s.command, e))?;
    let mut stdin = child.stdin.take().ok_or("MCP: no stdin")?;
    let stdout = child.stdout.take().ok_or("MCP: no stdout")?;
    let mut reader = BufReader::new(stdout).lines();
    let frame = |v: serde_json::Value| -> Vec<u8> { let mut l = serde_json::to_string(&v).unwrap_or_default(); l.push('\n'); l.into_bytes() };
    // 1) initialize
    stdin.write_all(&frame(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"Keak","version":"1.0"}}}))).await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())?;
    if let Err(e) = mcp_read_result(&mut reader, 1).await { let _ = child.kill().await; return Err(e); }
    // 2) initialized notification
    stdin.write_all(&frame(serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"}))).await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())?;
    // 3) the actual call
    stdin.write_all(&frame(serde_json::json!({"jsonrpc":"2.0","id":2,"method":method,"params":params}))).await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())?;
    let result = mcp_read_result(&mut reader, 2).await;
    let _ = child.kill().await;
    serde_json::to_string(&result?).map_err(|e| e.to_string())
}
#[tauri::command]
async fn mcp_rpc(args: McpCallArgs) -> Result<String, String> {
    match args.server.transport.as_str() {
        "remote" => mcp_remote(&args.server, &args.method, &args.params).await,
        _ => mcp_local(&args.server, &args.method, &args.params).await,
    }
}

// The bridge injected into the main window, which loads the keak.app dashboard inside it. It gives the site a
// desktop flag and a keakOpen() so the dashboard's "Keak AI" / "Connect your AI" buttons open the native windows
// we built. keakOpen navigates to a sentinel path that on_navigation (below) intercepts and cancels.
const KEAK_BRIDGE_JS: &str = r#"(function(){window.__KEAK_DESKTOP__=true;window.keakOpen=function(what){try{window.location.assign('/__keak_open/'+encodeURIComponent(what));}catch(e){}};})();"#;

// Open the right native window for a keakOpen("...") call. "keakai" and "connect" both open the Connect window
// (that is where the real Keak AI / Work chat lives); "keakai" also jumps it to the Work chat.
fn keak_open_window(app: &AppHandle, what: &str) {
    if what == "agents" {
        if let Some(w) = app.get_webview_window("agents") { let _ = w.show(); let _ = w.set_focus(); }
        return;
    }
    if let Some(w) = app.get_webview_window("connect") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if what == "keakai" { let _ = w.emit("keak-open-work", ()); }
    }
}

// ── Standby orb (Hey Keak) — always-on corner orb that talks to Keak AI hands-free ─────────────────
// The orb drives the SAME Keak AI flow as Ctrl+Alt: orb_talk_start shows the overlay and emits alt-start,
// orb_talk_stop emits alt-stop (overlay records, then processes). set_standby parks the orb in the
// bottom-right corner and shows/hides it. Wake-word detection ("Hey Keak") calls the same start/stop path.
#[tauri::command]
fn orb_talk_start(app: AppHandle) {
    // ONE orb only: hide the corner orb and show the centered Keak AI panel, so the orb reads as flying from
    // the corner to the middle (the overlay animates the slide). The overlay restores the corner orb when the
    // turn ends. The centered orb is clickable to stop the turn.
    if let Some(orb) = app.get_webview_window("orb") { let _ = orb.hide(); }
    if let Some(overlay) = app.get_webview_window("overlay") { let _ = overlay.show(); }
    let _ = app.emit("alt-start", ());
}

// Show the Keak AI panel (used by the "Hey Keak" wake turn, which does its own recording + auto-stop).
#[tauri::command]
fn orb_show(app: AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") { let _ = overlay.show(); }
}

// Hide the corner orb (while a centered turn is on screen, so there's never a second orb).
#[tauri::command]
fn orb_hide(app: AppHandle) {
    if let Some(orb) = app.get_webview_window("orb") { let _ = orb.hide(); }
}

#[tauri::command]
fn orb_talk_stop(app: AppHandle) {
    let _ = app.emit("alt-stop", ());
}

#[tauri::command]
fn set_standby(app: AppHandle, on: bool, corner: Option<String>) {
    if let Some(orb) = app.get_webview_window("orb") {
        if on {
            let _ = orb.show();
            // Park it in the chosen corner. corner = "br" | "bl" | "tr" | "tl" (default bottom-right).
            if let Ok(Some(mon)) = orb.primary_monitor() {
                let sz = mon.size();
                let sf = mon.scale_factor();
                let ow = (96.0 * sf) as i32;
                let margin = (24.0 * sf) as i32;
                let taskbar = (52.0 * sf) as i32; // clear the Windows taskbar on the bottom edge
                let c = corner.unwrap_or_else(|| "br".into());
                let right = c.ends_with('r');
                let bottom = c.starts_with('b');
                let x = if right { sz.width as i32 - ow - margin } else { margin };
                let y = if bottom { sz.height as i32 - ow - margin - taskbar } else { margin };
                let _ = orb.set_position(tauri::PhysicalPosition::new(x, y));
            }
            let _ = orb.set_always_on_top(true);
        } else {
            let _ = orb.hide();
        }
    }
}

// ── Hey Keak wake word (on-device, no cloud) ───────────────────────────────────────────────────────
// A personal wake word ("Hey Keak") trained from a few of the user's own voice samples (WAV files under
// app-data/wake). rustpotter runs the detector on a live cpal mic stream entirely on-device; on a match it
// emits "wake-detected", which the overlay turns into a hands-free Keak AI turn. Nothing leaves the machine.
#[cfg(windows)]
mod wake {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, Manager};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use rustpotter::{Rustpotter, RustpotterConfig, SampleFormat, ScoreMode, Wakeword};

    static RUNNING: AtomicBool = AtomicBool::new(false);

    fn wake_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
        app.path().app_data_dir().ok().map(|d| d.join("wake"))
    }
    // Each wake target lives in its own place: Keak ("" or "keak") = wav files directly in wake/, and each
    // agent = wake/a_<key>/*.wav. This lets one engine listen for "Hey Keak" AND "Hey <agent>" at once.
    fn target_dir(app: &AppHandle, key: &str) -> Option<std::path::PathBuf> {
        let root = wake_dir(app)?;
        if key.is_empty() || key == "keak" { Some(root) } else { Some(root.join(format!("a_{}", key))) }
    }
    fn wavs_in(dir: &std::path::Path) -> Vec<String> {
        let mut v = Vec::new();
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_file() && p.extension().and_then(|x| x.to_str()) == Some("wav") {
                    if let Some(s) = p.to_str() { v.push(s.to_string()); }
                }
            }
        }
        v.sort();
        v
    }
    // Every trained wake word: ("hey_keak", …) plus one per trained agent (its key = the wakeword name we
    // emit on a match, so the overlay knows WHICH agent to wake).
    fn all_targets(app: &AppHandle) -> Vec<(String, Vec<String>)> {
        let mut out = Vec::new();
        if let Some(root) = wake_dir(app) {
            let keak = wavs_in(&root);
            if !keak.is_empty() { out.push(("hey_keak".to_string(), keak)); }
            if let Ok(rd) = std::fs::read_dir(&root) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        if let Some(name) = p.file_name().and_then(|x| x.to_str()) {
                            if let Some(key) = name.strip_prefix("a_") {
                                let w = wavs_in(&p);
                                if !w.is_empty() { out.push((key.to_string(), w)); }
                            }
                        }
                    }
                }
            }
        }
        out
    }
    pub fn has_samples(app: &AppHandle, key: &str) -> usize {
        target_dir(app, key).map(|d| wavs_in(&d).len()).unwrap_or(0)
    }
    pub fn save_sample(app: &AppHandle, key: &str, index: u32, b64: &str) -> Result<(), String> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
        let dir = target_dir(app, key).ok_or("no app data dir")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(format!("keak_{}.wav", index)), bytes).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn clear_samples(app: &AppHandle, key: &str) {
        if key.is_empty() || key == "keak" {
            // Only remove Keak's own wav files at the root — never the agent subfolders.
            if let Some(dir) = wake_dir(app) {
                if let Ok(rd) = std::fs::read_dir(&dir) {
                    for e in rd.flatten() {
                        let p = e.path();
                        if p.is_file() && p.extension().and_then(|x| x.to_str()) == Some("wav") { let _ = std::fs::remove_file(&p); }
                    }
                }
            }
        } else if let Some(dir) = target_dir(app, key) {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    pub fn stop() { RUNNING.store(false, Ordering::SeqCst); }

    pub fn start(app: AppHandle) -> Result<(), String> {
        let targets = all_targets(&app);
        if targets.is_empty() { return Err("No wake word trained yet".into()); }
        if RUNNING.swap(true, Ordering::SeqCst) { return Ok(()); } // already listening
        std::thread::spawn(move || {
            if let Err(e) = run_loop(&app, targets) { eprintln!("[KEAK wake] {}", e); }
            RUNNING.store(false, Ordering::SeqCst);
        });
        Ok(())
    }

    fn run_loop(app: &AppHandle, targets: Vec<(String, Vec<String>)>) -> Result<(), String> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or("no input device")?;
        let supported = device.default_input_config().map_err(|e| e.to_string())?;
        let sample_format = supported.sample_format();
        let stream_config: cpal::StreamConfig = supported.into();

        let mut config = RustpotterConfig::default();
        config.fmt.sample_rate = stream_config.sample_rate.0 as usize;
        config.fmt.channels = stream_config.channels;
        config.fmt.sample_format = SampleFormat::Float;
        config.fmt.bits_per_sample = 32;
        config.detector.score_mode = ScoreMode::Max;
        config.detector.avg_threshold = 0.18;
        config.detector.threshold = 0.40;
        config.detector.min_scores = 4;

        let mut rustpotter = Rustpotter::new(&config)?;
        // Load every trained wake word (Keak + each agent). On a match, det.name tells us which one fired.
        for (name, paths) in &targets {
            match Wakeword::new_from_sample_files(name.clone(), None, None, paths.clone()) {
                Ok(w) => rustpotter.add_wakeword(w),
                Err(e) => eprintln!("[KEAK wake] wakeword '{}' failed: {}", name, e),
            }
        }
        let frame = rustpotter.get_samples_per_frame();
        let app_cb = app.clone();
        let err_fn = |e| eprintln!("[KEAK wake] stream error: {}", e);

        let stream = match sample_format {
            cpal::SampleFormat::F32 => {
                let mut rp = rustpotter;
                let mut buf: Vec<f32> = Vec::with_capacity(frame * 4);
                let mut last: Option<Instant> = None;
                let app2 = app_cb.clone();
                device.build_input_stream(
                    &stream_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        buf.extend_from_slice(data);
                        while buf.len() >= frame {
                            let chunk: Vec<f32> = buf.drain(..frame).collect();
                            if let Some(det) = rp.process_f32(&chunk) {
                                let now = Instant::now();
                                let ok = last.map_or(true, |t| now.duration_since(t) > Duration::from_millis(2500));
                                if ok { last = Some(now); let _ = app2.emit("wake-detected", det.name.clone()); }
                            }
                        }
                    },
                    err_fn, None,
                ).map_err(|e| e.to_string())?
            }
            cpal::SampleFormat::I16 => {
                let mut rp = rustpotter;
                let mut buf: Vec<f32> = Vec::with_capacity(frame * 4);
                let mut last: Option<Instant> = None;
                let app2 = app_cb.clone();
                device.build_input_stream(
                    &stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        buf.extend(data.iter().map(|s| *s as f32 / 32768.0));
                        while buf.len() >= frame {
                            let chunk: Vec<f32> = buf.drain(..frame).collect();
                            if let Some(det) = rp.process_f32(&chunk) {
                                let now = Instant::now();
                                let ok = last.map_or(true, |t| now.duration_since(t) > Duration::from_millis(2500));
                                if ok { last = Some(now); let _ = app2.emit("wake-detected", det.name.clone()); }
                            }
                        }
                    },
                    err_fn, None,
                ).map_err(|e| e.to_string())?
            }
            other => return Err(format!("unsupported input sample format: {:?}", other)),
        };

        stream.play().map_err(|e| e.to_string())?;
        while RUNNING.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(100)); }
        drop(stream);
        Ok(())
    }
}

// ── Keak Recap — capture the computer's audio (a meeting, a video, a call) and recap it ─────────────
// Uses WASAPI loopback: cpal opens an INPUT stream on the default OUTPUT device, which captures whatever
// the system is playing (the people you hear on the call). Everything stays on the machine until Keak
// sends it to the user's own transcription. Mixed down to mono, resampled to 16 kHz for transcription.
#[cfg(windows)]
mod recap {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use tauri::{AppHandle, Manager};

    static RUNNING: AtomicBool = AtomicBool::new(false);
    static CAPTURE_MIC: AtomicBool = AtomicBool::new(true);  // also mix in the user's own microphone
    static RAW: Mutex<Vec<f32>> = Mutex::new(Vec::new());   // system audio (loopback), mono at device rate
    static SR: Mutex<u32> = Mutex::new(48000);
    static MIC: Mutex<Vec<f32>> = Mutex::new(Vec::new());   // the user's mic, mono at its device rate
    static MIC_SR: Mutex<u32> = Mutex::new(48000);
    static R16K: Mutex<Vec<f32>> = Mutex::new(Vec::new());  // final mixed mono 16 kHz (built on stop)

    pub fn start(capture_mic: bool) -> Result<(), String> {
        if RUNNING.swap(true, Ordering::SeqCst) { return Ok(()); }
        CAPTURE_MIC.store(capture_mic, Ordering::SeqCst);
        RAW.lock().unwrap().clear();
        MIC.lock().unwrap().clear();
        R16K.lock().unwrap().clear();
        std::thread::spawn(move || {
            if let Err(e) = run() { eprintln!("[KEAK recap] {}", e); }
            RUNNING.store(false, Ordering::SeqCst);
        });
        Ok(())
    }
    // Build an input stream that downmixes any format to mono f32 and appends into `target`.
    fn build_capture(device: &cpal::Device, config: &cpal::StreamConfig, fmt: cpal::SampleFormat, channels: usize, target: &'static Mutex<Vec<f32>>) -> Result<cpal::Stream, String> {
        let err_fn = |e| eprintln!("[KEAK recap] stream error: {}", e);
        let ch = channels.max(1);
        match fmt {
            cpal::SampleFormat::F32 => device.build_input_stream(config, move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let mut buf = target.lock().unwrap();
                for frame in data.chunks(ch) { buf.push(frame.iter().sum::<f32>() / ch as f32); }
            }, err_fn, None).map_err(|e| e.to_string()),
            cpal::SampleFormat::I16 => device.build_input_stream(config, move |data: &[i16], _: &cpal::InputCallbackInfo| {
                let mut buf = target.lock().unwrap();
                for frame in data.chunks(ch) { buf.push(frame.iter().map(|x| *x as f32 / 32768.0).sum::<f32>() / ch as f32); }
            }, err_fn, None).map_err(|e| e.to_string()),
            cpal::SampleFormat::U16 => device.build_input_stream(config, move |data: &[u16], _: &cpal::InputCallbackInfo| {
                let mut buf = target.lock().unwrap();
                for frame in data.chunks(ch) { buf.push(frame.iter().map(|x| (*x as f32 - 32768.0) / 32768.0).sum::<f32>() / ch as f32); }
            }, err_fn, None).map_err(|e| e.to_string()),
            other => Err(format!("unsupported format {:?}", other)),
        }
    }
    fn run() -> Result<(), String> {
        let host = cpal::default_host();
        // System audio via WASAPI loopback = an input stream on the default OUTPUT device.
        let out_device = host.default_output_device().ok_or("no output device (nothing is playing to capture)")?;
        let out_config = out_device.default_output_config().map_err(|e| e.to_string())?;
        let out_fmt = out_config.sample_format();
        let out_channels = out_config.channels() as usize;
        *SR.lock().unwrap() = out_config.sample_rate().0;
        let out_stream_config: cpal::StreamConfig = out_config.into();
        let loop_stream = build_capture(&out_device, &out_stream_config, out_fmt, out_channels, &RAW)?;
        loop_stream.play().map_err(|e| e.to_string())?;
        // The user's own microphone (mixed in on stop) — best-effort so a missing mic never fails the recap.
        let mic_stream = if CAPTURE_MIC.load(Ordering::SeqCst) {
            match host.default_input_device().and_then(|d| d.default_input_config().ok().map(|c| (d, c))) {
                Some((in_device, in_config)) => {
                    let in_fmt = in_config.sample_format();
                    let in_channels = in_config.channels() as usize;
                    *MIC_SR.lock().unwrap() = in_config.sample_rate().0;
                    let in_stream_config: cpal::StreamConfig = in_config.into();
                    match build_capture(&in_device, &in_stream_config, in_fmt, in_channels, &MIC) {
                        Ok(s) => { let _ = s.play(); Some(s) }
                        Err(e) => { eprintln!("[KEAK recap] mic: {}", e); None }
                    }
                }
                None => { eprintln!("[KEAK recap] no mic available; system audio only"); None }
            }
        } else { None };
        while RUNNING.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(100)); }
        drop(loop_stream);
        drop(mic_stream);
        Ok(())
    }
    fn resample_to_16k(src: &[f32], sr: u32) -> Vec<f32> {
        let target = 16000f32;
        if sr == 16000 || src.is_empty() { return src.to_vec(); }
        let ratio = target / sr as f32;
        let out_len = (src.len() as f32 * ratio) as usize;
        let mut out = Vec::with_capacity(out_len);
        for i in 0..out_len {
            let pos = i as f32 / ratio;
            let idx = pos as usize;
            let frac = pos - idx as f32;
            let a = src.get(idx).copied().unwrap_or(0.0);
            let b = src.get(idx + 1).copied().unwrap_or(a);
            out.push(a + (b - a) * frac);
        }
        out
    }
    fn wav_bytes(samples: &[f32], rate: u32) -> Vec<u8> {
        let n = samples.len();
        let mut v = Vec::with_capacity(44 + n * 2);
        let data_len = (n * 2) as u32;
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data_len).to_le_bytes());
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());      // PCM
        v.extend_from_slice(&1u16.to_le_bytes());      // mono
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
        v.extend_from_slice(&2u16.to_le_bytes());      // block align
        v.extend_from_slice(&16u16.to_le_bytes());     // bits
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_len.to_le_bytes());
        for &s in samples {
            let c = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            v.extend_from_slice(&c.to_le_bytes());
        }
        v
    }
    // Stop capture, resample to 16 kHz mono, write a full WAV to app-data/recap/recap.wav.
    // Returns (path, seconds).
    pub fn stop(app: &AppHandle) -> Result<(String, f32), String> {
        RUNNING.store(false, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(250)); // let the streams flush their last buffers
        let sr = *SR.lock().unwrap();
        let raw = RAW.lock().unwrap().clone();
        let mut r16 = resample_to_16k(&raw, sr);
        // Mix in the user's own mic (both captured from the same start moment, so index-aligned at 16 kHz).
        if CAPTURE_MIC.load(Ordering::SeqCst) {
            let mic_sr = *MIC_SR.lock().unwrap();
            let mic_raw = MIC.lock().unwrap().clone();
            if !mic_raw.is_empty() {
                let mic16 = resample_to_16k(&mic_raw, mic_sr);
                if mic16.len() > r16.len() { r16.resize(mic16.len(), 0.0); }
                for i in 0..mic16.len() { r16[i] = (r16[i] + mic16[i]).clamp(-1.0, 1.0); }
            }
        }
        let secs = r16.len() as f32 / 16000.0;
        *R16K.lock().unwrap() = r16.clone();
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("recap");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("recap.wav");
        std::fs::write(&path, wav_bytes(&r16, 16000)).map_err(|e| e.to_string())?;
        Ok((path.to_string_lossy().to_string(), secs))
    }
    pub fn is_running() -> bool { RUNNING.load(Ordering::SeqCst) }
    pub fn seconds() -> f32 { RAW.lock().unwrap().len() as f32 / *SR.lock().unwrap() as f32 }
    // Stop and throw the capture away (a mistaken/empty recording) without transcribing anything.
    pub fn cancel() {
        RUNNING.store(false, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(150));
        RAW.lock().unwrap().clear();
        MIC.lock().unwrap().clear();
        R16K.lock().unwrap().clear();
    }
    // One ~chunk_secs slice of the resampled recording as a base64 WAV (so JS can transcribe long meetings
    // chunk by chunk without holding the whole thing in memory).
    pub fn chunk_count(chunk_secs: u32) -> usize {
        let per = (chunk_secs * 16000) as usize;
        let len = R16K.lock().unwrap().len();
        if per == 0 || len == 0 { 0 } else { (len + per - 1) / per }
    }
    pub fn chunk_b64(index: usize, chunk_secs: u32) -> String {
        use base64::Engine;
        let per = (chunk_secs * 16000) as usize;
        let buf = R16K.lock().unwrap();
        let start = index * per;
        if start >= buf.len() { return String::new(); }
        let end = (start + per).min(buf.len());
        base64::engine::general_purpose::STANDARD.encode(wav_bytes(&buf[start..end], 16000))
    }
}

#[tauri::command]
fn recap_start(mic: Option<bool>) -> Result<(), String> {
    #[cfg(windows)] { recap::start(mic.unwrap_or(true)) }
    #[cfg(not(windows))] { let _ = mic; Err("Recap is Windows-only for now".into()) }
}
#[tauri::command]
fn recap_stop(app: AppHandle) -> Result<(String, f32), String> {
    #[cfg(windows)] { recap::stop(&app) }
    #[cfg(not(windows))] { let _ = app; Err("Windows-only".into()) }
}
#[tauri::command]
fn recap_status() -> (bool, f32) {
    #[cfg(windows)] { (recap::is_running(), recap::seconds()) }
    #[cfg(not(windows))] { (false, 0.0) }
}
#[tauri::command]
fn recap_chunk_count(chunk_secs: u32) -> usize {
    #[cfg(windows)] { recap::chunk_count(chunk_secs) }
    #[cfg(not(windows))] { let _ = chunk_secs; 0 }
}
#[tauri::command]
fn recap_chunk_b64(index: usize, chunk_secs: u32) -> String {
    #[cfg(windows)] { recap::chunk_b64(index, chunk_secs) }
    #[cfg(not(windows))] { let _ = (index, chunk_secs); String::new() }
}
#[tauri::command]
fn recap_cancel() {
    #[cfg(windows)] { recap::cancel(); }
}

#[tauri::command]
fn wake_start(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)] { wake::start(app) }
    #[cfg(not(windows))] { let _ = app; Err("Wake word is Windows-only for now".into()) }
}
#[tauri::command]
fn wake_stop() {
    #[cfg(windows)] { wake::stop(); }
}
#[tauri::command]
fn wake_save_sample(app: AppHandle, key: Option<String>, index: u32, wav_base64: String) -> Result<(), String> {
    #[cfg(windows)] { wake::save_sample(&app, key.as_deref().unwrap_or("keak"), index, &wav_base64) }
    #[cfg(not(windows))] { let _ = (app, key, index, wav_base64); Err("Windows-only".into()) }
}
#[tauri::command]
fn wake_clear(app: AppHandle, key: Option<String>) {
    #[cfg(windows)] { wake::clear_samples(&app, key.as_deref().unwrap_or("keak")); }
    #[cfg(not(windows))] { let _ = (app, key); }
}
#[tauri::command]
fn wake_has_samples(app: AppHandle, key: Option<String>) -> usize {
    #[cfg(windows)] { return wake::has_samples(&app, key.as_deref().unwrap_or("keak")); }
    #[cfg(not(windows))] { let _ = (app, key); 0 }
}

// ── Keak Sovereign: local speech engine (faster-whisper) management ────────────────────────────────
// The engine is a standalone build of the local-whisper server (FastAPI + faster-whisper) that serves
// /health + /transcribe on 127.0.0.1:9889 — the contract the overlay already uses. Keak downloads the
// prebuilt engine on first Sovereign enable and starts/stops it with the toggle. Nothing leaves the
// machine. In dev, set KEAK_STT_SCRIPT to a local server.py path to run it via python instead.
static STT_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

fn stt_asset_name() -> &'static str {
    #[cfg(windows)] { "keak-stt-windows-x64.exe" }
    #[cfg(target_os = "macos")] { "keak-stt-macos" }
    #[cfg(all(unix, not(target_os = "macos")))] { "keak-stt-linux" }
}
fn stt_engine_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("stt").join(stt_asset_name()))
}
fn stt_is_running() -> bool {
    let mut g = STT_CHILD.lock().unwrap();
    match g.as_mut() {
        Some(c) => matches!(c.try_wait(), Ok(None)),
        None => false,
    }
}

#[tauri::command]
fn stt_status(app: AppHandle) -> serde_json::Value {
    let engine = stt_engine_path(&app);
    serde_json::json!({
        "running": stt_is_running(),
        "engineInstalled": engine.as_ref().map(|p| p.exists()).unwrap_or(false),
    })
}

#[tauri::command]
fn stt_start(app: AppHandle) -> Result<(), String> {
    if stt_is_running() { return Ok(()); }
    // Prefer the downloaded standalone engine; in dev fall back to python + a server.py path from env.
    let (program, args): (String, Vec<String>) = match stt_engine_path(&app) {
        Some(p) if p.exists() => (p.to_string_lossy().to_string(), vec![]),
        _ => {
            let script = std::env::var("KEAK_STT_SCRIPT").unwrap_or_default();
            if script.is_empty() {
                return Err("The local speech engine isn't installed yet. Turn on Sovereign to download it first.".into());
            }
            let py = if cfg!(windows) { "python".to_string() } else { "python3".to_string() };
            (py, vec![script])
        }
    };
    let mut cmd = std::process::Command::new(&program);
    cmd.args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); }
    let child = cmd.spawn().map_err(|e| format!("Couldn't start the local speech engine: {}", e))?;
    *STT_CHILD.lock().unwrap() = Some(child);
    Ok(())
}

#[tauri::command]
fn stt_stop() -> Result<(), String> {
    if let Some(mut c) = STT_CHILD.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    Ok(())
}

#[tauri::command]
async fn stt_download_engine(app: AppHandle) -> Result<(), String> {
    let dest = stt_engine_path(&app).ok_or("No app data directory")?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let url = format!(
        "https://github.com/PepSecanell/keak-desktop/releases/download/stt-engine/{}",
        stt_asset_name()
    );
    let _ = app.emit("stt-download-progress", 0u32);
    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Couldn't download the engine ({}). It may not be published yet.", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let tmp = dest.with_extension("part");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
    }
    let _ = app.emit("stt-download-progress", 100u32);
    Ok(())
}

// ── Listening orb window — small transparent pill shown during PTT recording ─────────────────────────
// A dedicated 220×64 chromeless window that floats near the bottom of the screen. Created lazily on
// first call; subsequent calls just show/hide it so the DOM stays alive and the animation keeps running.
#[tauri::command]
fn show_listening_orb(app: AppHandle) {
    if let Some(w) = app.get_webview_window("listening-orb") {
        let _ = w.set_ignore_cursor_events(true);
        let _ = w.show();
        return;
    }
    let primary_pos: (f64, f64) = app.get_webview_window("overlay")
        .and_then(|w| w.primary_monitor().ok().flatten())
        .map(|m| {
            let sf = m.scale_factor();
            let sz = m.size();
            let x = (sz.width as f64 / sf / 2.0) - 110.0;
            let y = (sz.height as f64 / sf) - 120.0 - 64.0;
            (x, y)
        })
        .unwrap_or((760.0, 820.0));
    if let Ok(w) = tauri::WebviewWindowBuilder::new(
        &app,
        "listening-orb",
        tauri::WebviewUrl::App("orb/index.html".into()),
    )
    .title("Keak")
    .inner_size(220.0, 64.0)
    .position(primary_pos.0, primary_pos.1)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .build() {
        // Mouse events pass through the orb — cursor stays visible and the user can still
        // click on whatever is behind it. The orb is purely visual.
        let _ = w.set_ignore_cursor_events(true);
    }
}

#[tauri::command]
fn hide_listening_orb(app: AppHandle) {
    if let Some(w) = app.get_webview_window("listening-orb") {
        let _ = w.hide();
    }
}

// Write the recorded audio (base64 webm) to a temp file and return its path. No network at all — pure
// disk I/O, which always works. The frontend then hands this path to the whisper server via a GET
// (GET works from the app; POST does not — blocked by security software/proxy on the app process).
#[tauri::command]
fn save_temp_audio(audio: String, language: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD
        .decode(audio.as_bytes())
        .map_err(|e| format!("decode audio: {e}"))?;
    let dir = std::env::temp_dir();
    let webm = dir.join("keak_job.webm");
    let result = dir.join("keak_job.result.json");
    let request = dir.join("keak_job.request");
    // Clear any stale result from a previous job so the poll can't read an old transcript.
    let _ = std::fs::remove_file(&result);
    // Write the audio first, THEN the request marker — the server watcher only fires on the marker, so the
    // audio is always fully written before it's read. The marker's contents are the forced language ("" = auto).
    std::fs::write(&webm, &bytes).map_err(|e| format!("write audio: {e}"))?;
    std::fs::write(&request, language.as_bytes()).map_err(|e| format!("write request: {e}"))?;
    Ok(result.to_string_lossy().to_string())
}

// Read the transcription result file the whisper server wrote (and delete it). Returns None until it
// exists. The app polls this instead of reading an HTTP response, which is unreliable on this machine.
#[tauri::command]
fn read_result_file(path: String) -> Option<String> {
    let content = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    Some(content)
}

// (kept for reference / future use) Transcribe via the local whisper server FROM RUST using reqwest.
// Unreliable in practice: the app process's outbound POST to localhost is blocked (security software /
// proxy), so this returns "error sending request". The file+GET path via save_temp_audio is used instead.
#[tauri::command]
async fn stt_transcribe(audio: String, language: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD
        .decode(audio.as_bytes())
        .map_err(|e| format!("decode audio: {e}"))?;
    let boundary = "KeakBoundary7fZ2x9Qk";
    let mut body: Vec<u8> = Vec::with_capacity(bytes.len() + 512);
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"rec.webm\"\r\nContent-Type: audio/webm\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(&bytes);
    body.extend_from_slice(
        format!("\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\n{language}\r\n--{boundary}--\r\n").as_bytes(),
    );
    // .no_proxy() is critical: without it reqwest routes 127.0.0.1 through the Windows system proxy and
    // hangs forever. connect_timeout fails fast if the server is down; the overall timeout covers slow CPU
    // transcription.
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("client: {e}"))?;
    let resp = client
        .post("http://127.0.0.1:9889/transcribe")
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("connect: {e}"))?;
    resp.text().await.map_err(|e| format!("read: {e}"))
}

// ── PTT mode toggle — "hold" (default) vs "tap" ───────────────────────────────────────────────────────
// In tap mode the first Ctrl+Win press starts recording; the second press stops it. Persisted in the
// ptt_watch module's own atomics so the poller thread can read it without any cross-module state.
// ptt_watch is Windows-only; on macOS/Linux this is a no-op (PTT is keyboard-driven on Windows only).
#[tauri::command]
fn set_ptt_mode(mode: String) {
    #[cfg(windows)] { ptt_watch::set_tap_mode(mode == "tap"); }
    #[cfg(not(windows))] { let _ = mode; }
}

// ── Sovereign model helpers — ggml Whisper model download + status ───────────────────────────────────
// The keak-stt sidecar expects the model file at {app_data_dir}/keak-stt/ggml-large-v3-turbo-q5_0.bin.
// stt_model_status reports whether it's present and how large it is. stt_download_model streams it from
// HuggingFace and emits progress events so the frontend can show a progress bar.

fn sovereign_model_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| {
        d.join("keak-stt").join("ggml-large-v3-turbo-q5_0.bin")
    })
}

#[tauri::command]
fn stt_model_status(app: AppHandle) -> serde_json::Value {
    match sovereign_model_path(&app) {
        Some(p) => {
            let present = p.exists();
            let size_mb = if present {
                std::fs::metadata(&p).map(|m| m.len() as f64 / 1_000_000.0).unwrap_or(0.0)
            } else {
                0.0
            };
            serde_json::json!({ "present": present, "path": p.to_string_lossy(), "size_mb": size_mb })
        }
        None => serde_json::json!({ "present": false, "path": "", "size_mb": 0.0 }),
    }
}

#[tauri::command]
async fn stt_health() -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client.get("http://127.0.0.1:9889/health").send().await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

#[tauri::command]
async fn stt_download_model(app: AppHandle) -> Result<(), String> {
    use futures_util::StreamExt;
    let dest = sovereign_model_path(&app).ok_or("No app data directory")?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";
    let _ = app.emit("stt-model-progress", serde_json::json!({ "pct": 0.0 }));
    let client = reqwest::Client::new();
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Download failed ({})", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let tmp = dest.with_extension("part");
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if total > 0 {
            let pct = (downloaded as f64 / total as f64) * 100.0;
            let _ = app.emit("stt-model-progress", serde_json::json!({ "pct": pct }));
        }
    }
    drop(file);
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    let _ = app.emit("stt-model-progress", serde_json::json!({ "pct": 100.0 }));
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
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            // Push-to-talk via a key-state watcher, so bare modifier combos work:
            //   Ctrl+Win = dictate, Ctrl+Alt = Thought Dump. Hold to record, release to insert.
            #[cfg(windows)]
            ptt_watch::install(app.handle().clone());

            // Create the main window in code (not tauri.conf.json) so we can inject the keak.app<>desktop bridge.
            // The dashboard is the keak.app site loaded inside this window; the bridge lets its buttons open the
            // native Keak AI / Connect / Agents windows we built. A sentinel "/__keak_open/<what>" navigation is
            // cancelled and turned into the matching native window.
            let bridge_handle = app.handle().clone();
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("/".into()))
                .title("Keak")
                .inner_size(800.0, 560.0)
                .resizable(false)
                .visible(false)
                .initialization_script(KEAK_BRIDGE_JS)
                .on_navigation(move |url| {
                    if let Some(rest) = url.path().strip_prefix("/__keak_open/") {
                        keak_open_window(&bridge_handle, rest.trim_matches('/'));
                        return false; // a bridge signal, not a real page load
                    }
                    true
                })
                .build()?;

            // Start the Chrome extension WebSocket bridge on localhost:7777.
            // The extension connects here so Keak AI can send browser commands (click, type, etc.).
            {
                let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
                *BROWSER_TX.lock().unwrap() = Some(tx);
                let app_for_ws = app.handle().clone();
                std::thread::spawn(move || {
                    use tokio_tungstenite::accept_async;
                    use tokio_tungstenite::tungstenite::Message;
                    use futures_util::{SinkExt, StreamExt};
                    let rt = tokio::runtime::Runtime::new().unwrap();
                    rt.block_on(async move {
                        let listener = tokio::net::TcpListener::bind("127.0.0.1:7777").await
                            .expect("Could not bind WebSocket port 7777");
                        loop {
                            let Ok((stream, _)) = listener.accept().await else { continue };
                            let Ok(ws_stream) = accept_async(stream).await else { continue };
                            let (mut sink, mut source) = ws_stream.split();
                            // Drain any queued commands to the new connection
                            let drain = tokio::spawn(async move {
                                while let Some(msg) = rx.recv().await {
                                    let _ = sink.send(Message::Text(msg.into())).await;
                                }
                            });
                            // Forward incoming messages (page snapshots, results) to the overlay
                            // as Tauri events so the multi-step browser agent loop can react.
                            let handle = app_for_ws.clone();
                            loop {
                                match source.next().await {
                                    Some(Ok(Message::Text(s))) => {
                                        let _ = handle.emit("browser-result", s.to_string());
                                    }
                                    Some(Ok(_)) => {} // ignore binary, ping, pong
                                    _ => break,        // disconnect or error
                                }
                            }
                            drain.abort();
                            // Recreate channel for next connection
                            let (new_tx, new_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
                            rx = new_rx;
                            *BROWSER_TX.lock().unwrap() = Some(new_tx);
                        }
                    });
                });
            }

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

            // The "connect" window (Connect your AI / screen control) is native, so it shares the
            // overlay's origin + localStorage. Hide it on close so the tray item can reopen it.
            if let Some(connect) = app.get_webview_window("connect") {
                let connect_for_event = connect.clone();
                connect.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = connect_for_event.hide();
                    }
                });
            }

            let quit_i = MenuItem::with_id(app, "quit", "Quit Keak", true, None::<&str>)?;
            let settings_i =
                MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let connect_i =
                MenuItem::with_id(app, "connect", "Connect your AI", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&connect_i, &settings_i, &quit_i])?;

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
                    "connect" => {
                        if let Some(w) = app.get_webview_window("connect") {
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
        .invoke_handler(tauri::generate_handler![open_url, inject_text, hide_overlay, show_main, show_agents, hide_agents, save_artifact, restore_clipboard, capture_selection, capture_screen, send_browser_command, capture_screen_full, mouse_click, mouse_move, cursor_pos, type_text, mouse_scroll, press_key, openai_login_start, openai_login_poll, cu_step, cu_chat, copilot_read_cli_token, ollama_list_models, pick_folder, set_autostart, get_autostart, whatsapp_send, sb_tree, sb_read, sb_write, sb_mkdir, sb_delete, sb_search, sb_graph, openai_tts, gemini_tts, google_connect, google_refresh, google_calendar_create, youtube_get, gmail_list, gmail_send, drive_create, ms_connect, ms_refresh, ms_calendar_create, ms_mail_send, ms_drive_create, notion_connect, notion_create_page, slack_connect, slack_test, slack_post, perplexity_ask, elevenlabs_tts, elevenlabs_speak, gamma_generate, heygen_video, webhook_post, manus_task, higgsfield_generate, heygen_assets, figma_connect, resend_send, supabase_rest, supabase_schema, figma_api, github_device_start, github_device_poll, github_api, shopify_api, gumloop_start, telegram_poll, telegram_send, telegram_get_voice, telegram_set_photo, mcp_rpc, claude_verify, claude_read_cli_token, make_scenarios, make_run, stt_status, stt_start, stt_stop, stt_download_engine, stt_health, stt_model_status, stt_download_model, stt_transcribe, save_temp_audio, read_result_file, show_listening_orb, hide_listening_orb, set_ptt_mode, orb_talk_start, orb_talk_stop, orb_show, orb_hide, set_standby, wake_start, wake_stop, wake_save_sample, wake_clear, wake_has_samples, recap_start, recap_stop, recap_status, recap_chunk_count, recap_chunk_b64, recap_cancel, stream_type, stream_replace])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Push-to-talk watcher. Bare modifier combos (Ctrl+Win, Ctrl+Alt) can't be registered as normal
// global shortcuts, so we poll key state ~30ms and drive the same ptt-start / ptt-stop events.
#[cfg(windows)]
mod ptt_watch {
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::OnceLock;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager};
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    // 0 = idle, 1 = dictate (Ctrl+Win), 2 = alt (Ctrl+Alt — JS routes to Keak AI or Thought Dump),
    // 3 = rewrite (Win+Alt — rewrite the current selection from a spoken instruction),
    // 4 = translate-dictate (Ctrl+Space — dictate and translate into the chosen language)
    static ACTIVE: AtomicU8 = AtomicU8::new(0);
    // PTT tap mode: false = hold-to-record (default), true = first press starts / second press stops
    static PTT_TAP_MODE: AtomicBool = AtomicBool::new(false);
    // Whether recording is currently active (used in tap mode to decide start vs stop on keydown)
    static PTT_RECORDING: AtomicBool = AtomicBool::new(false);

    pub fn set_tap_mode(tap: bool) {
        PTT_TAP_MODE.store(tap, Ordering::SeqCst);
    }

    // Tracks whether Ctrl+Win was down on the previous poll tick, so we can detect the rising edge
    // (key just became pressed) for tap mode's second-press stop.
    static CTRL_WIN_PREV: AtomicBool = AtomicBool::new(false);

    fn down(vk: i32) -> bool {
        (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
    }

    fn show_overlay(app: &AppHandle) {
        if let Some(overlay) = app.get_webview_window("overlay") {
            let _ = overlay.show();
        }
    }

    #[derive(Clone, serde::Serialize)]
    struct PttStart { dump: bool, translate: bool }

    fn start_dictate(translate: bool, active: u8) {
        ACTIVE.store(active, Ordering::SeqCst);
        PTT_RECORDING.store(true, Ordering::SeqCst);
        if let Some(app) = APP.get() {
            show_overlay(app);
            // Ctrl+Win = plain dictation (translate=false). Ctrl+Space = dictate + translate (translate=true).
            let _ = app.emit("ptt-start", PttStart { dump: false, translate });
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
        PTT_RECORDING.store(false, Ordering::SeqCst);
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
            let ralt = down(0xA5); // VK_RMENU = AltGr. On many layouts (Spanish, etc.) AltGr fires as LCtrl+RAlt,
                                   // so we MUST exclude it from Ctrl+Space or normal typing triggers dictation.
            let space = down(0x20); // VK_SPACE — Ctrl+Space = dictate + translate
            // Mutually exclusive so the combos never overlap:
            let ctrl_win = ctrl && win && !lalt && !ralt; // Dictate (same language)
            let ctrl_win_prev = CTRL_WIN_PREV.load(Ordering::SeqCst);
            let ctrl_win_rising = ctrl_win && !ctrl_win_prev; // true only on the first tick the key is down
            CTRL_WIN_PREV.store(ctrl_win, Ordering::SeqCst);
            let ctrl_space = ctrl && space && !win && !lalt && !ralt; // Dictate + translate (NOT AltGr+Space)
            let ctrl_alt = ctrl && lalt && !win; // Thought Dump / Keak AI
            let win_alt = win && lalt && !ctrl; // Rewrite selection
            let tap_mode = PTT_TAP_MODE.load(Ordering::SeqCst);

            match ACTIVE.load(Ordering::SeqCst) {
                0 => {
                    if tap_mode {
                        // Tap mode: start on rising edge of Ctrl+Win only
                        if ctrl_win_rising {
                            start_dictate(false, 1);
                        } else if ctrl_space {
                            start_dictate(true, 4);
                        } else if ctrl_alt {
                            start_alt();
                        } else if win_alt {
                            start_rewrite();
                        }
                    } else {
                        // Hold mode (default): start while key is held
                        if ctrl_win {
                            start_dictate(false, 1);
                        } else if ctrl_space {
                            start_dictate(true, 4);
                        } else if ctrl_alt {
                            start_alt();
                        } else if win_alt {
                            start_rewrite();
                        }
                    }
                }
                1 => {
                    if tap_mode {
                        // Tap mode: stop on second rising edge of Ctrl+Win (key released then re-pressed)
                        if ctrl_win_rising {
                            emit_stop("ptt-stop");
                        }
                    } else {
                        // Hold mode: stop when key is released
                        if !ctrl_win {
                            emit_stop("ptt-stop");
                        }
                    }
                }
                4 => {
                    if !ctrl_space {
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
