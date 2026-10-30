//! Desktop shell for the flyscan.
//!
//! It does two things the browser could not. It owns the Python sidecar — the
//! scrapers stay in Python because `curl_cffi`'s TLS impersonation is what
//! makes the sources answer a plain HTTP request at all — and it holds the
//! security checks the sources occasionally ask for.
//!
//! That second one is why this is a desktop app rather than a web page. A
//! source's challenge grants cookies, and those cookies are what unblock the
//! scraper; a user solving the challenge in their own browser keeps them there,
//! where the scraper cannot reach. Here the challenge opens in a window this
//! process owns, so the cookies can be read back and handed to the sidecar.
//!
//! The captcha is never solved, answered or worked around by this code. It is
//! shown to the person sitting in front of it, and it waits.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

mod challenge_navigation;
use challenge_navigation::ChallengeNavigation;

/// How long to let someone work on a challenge before giving up on them.
const CHALLENGE_TIMEOUT: Duration = Duration::from_secs(300);
static CHALLENGE_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);

struct Sidecar {
    child: Mutex<Option<Child>>,
    port: u16,
    api_key: String,
}

#[derive(Serialize)]
struct CookieOut {
    name: String,
    value: String,
}

#[derive(Serialize)]
struct ChallengeOutcome {
    solved: bool,
    cookies: Vec<CookieOut>,
    landed_on: String,
}

/// Ask the OS for a port nobody is using, then let go of it.
///
/// There is a race here in principle — something else could take the port
/// between the release and the sidecar's bind — but on a desktop machine
/// binding a fresh ephemeral port twice in a row is not a real risk, and the
/// alternative is parsing the child's stdout.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(5111)
}

/// Where the packaged sidecar lives, in dev and in a bundle.
fn sidecar_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(explicit) = std::env::var("FLYSCAN_SIDECAR") {
        return Some(explicit.into());
    }
    let name = if cfg!(windows) {
        "flyscan-sidecar.exe"
    } else {
        "flyscan-sidecar"
    };
    // Bundled next to the executable...
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join(name);
        if bundled.exists() {
            return Some(bundled);
        }
    }
    // ...or built into packaging/dist while developing.
    if let Ok(exe) = std::env::current_exe() {
        let bundled = exe.parent()?.join(name);
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    if cfg!(debug_assertions) {
        let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packaging/dist")
            .join(name);
        return dev.is_file().then_some(dev);
    }
    None
}

/// A packaged build is not ready until its own authenticated API answers.
fn wait_for_sidecar(child: &mut Child, port: u16, key: &str) -> Result<(), String> {
    let address: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "The flight service exited during startup ({status})."
            ));
        }
        if let Ok(mut socket) = TcpStream::connect_timeout(&address, Duration::from_millis(200)) {
            let _ = socket.set_read_timeout(Some(Duration::from_millis(500)));
            let _ = socket.set_write_timeout(Some(Duration::from_millis(500)));
            let request = format!("GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n");
            if socket.write_all(request.as_bytes()).is_ok() {
                let mut response = [0; 128];
                if let Ok(count) = socket.read(&mut response) {
                    if String::from_utf8_lossy(&response[..count]).starts_with("HTTP/1.1 200") {
                        return Ok(());
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err("The flight service did not become ready within 45 seconds.".into())
}

fn startup_error(message: &str) {
    eprintln!("{message}");
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, flags: u32) -> i32;
        }
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let caption: Vec<u16> = "Flyscan could not start"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x10);
        }
    }
}

/// The sidecar's base URL, so the frontend does not have to guess the port.
#[tauri::command]
fn api_base(sidecar: State<'_, Sidecar>) -> String {
    format!("http://127.0.0.1:{}", sidecar.port)
}

#[tauri::command]
fn api_key(window: tauri::WebviewWindow, sidecar: State<'_, Sidecar>) -> Result<String, String> {
    if window.label() != "main" {
        return Err("Only the main window may access the local service.".into());
    }
    Ok(sidecar.api_key.clone())
}

#[tauri::command]
fn validate_update_restart(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window may install updates.".into());
    }
    if app
        .webview_windows()
        .keys()
        .any(|label| label.starts_with("challenge-"))
    {
        return Err("Finish or close the verification window before updating.".into());
    }
    Ok(())
}

/// Hand a booking link to the user's real browser.
///
/// A plain `<a target="_blank">` does nothing in a Tauri webview — there is no
/// handler for it — so booking links silently did nothing until this existed.
/// Sending them out to the real browser is also what the user wants: that is
/// where their logins and saved cards are, not in this app's webview.
///
/// **These URLs come from scraped pages, so they are not trusted.** Two rules
/// follow. Only `http`/`https` is opened, because a handler like `file:` or
/// `ms-msdt:` reaching the shell is how a booking link becomes code execution.
/// And the launcher is invoked with the URL as its own argv entry, never
/// through `cmd /C start`, so nothing in it can be read as shell syntax.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let allowed = url.starts_with("http://") || url.starts_with("https://");
    if !allowed {
        return Err(format!("refusing to open a non-web link: {url}"));
    }

    #[cfg(target_os = "windows")]
    // Not `start`: that is a cmd builtin and would need a shell. This is the
    // documented no-shell way to hand a URL to the default browser.
    let mut command = {
        let mut c = Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open {url}: {e}"))
}

/// Open a source's security check and wait for the person to clear it.
///
/// Async on purpose: reading cookies from a webview deadlocks on Windows if it
/// happens inside a synchronous command or an event handler.
#[tauri::command]
async fn open_challenge(app: AppHandle, url: String) -> Result<ChallengeOutcome, String> {
    let parsed: tauri::Url = url.parse().map_err(|_| format!("not a URL: {url}"))?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("Security checks must use an HTTPS web address.".into());
    }

    let label = format!(
        "challenge-{}",
        CHALLENGE_WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let navigation = Arc::new(Mutex::new(ChallengeNavigation::new(&parsed)));
    let load_navigation = Arc::clone(&navigation);
    let mut landed = parsed.clone();
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(parsed))
        .title("Security check — solve this to continue")
        .inner_size(560.0, 720.0)
        .center()
        .focused(true)
        .on_page_load(move |_, payload| {
            load_navigation
                .lock()
                .unwrap()
                .page_load(payload.url(), payload.event());
        })
        .build()
        .map_err(|e| format!("could not open the challenge window: {e}"))?;

    let started = Instant::now();
    let deadline = started + CHALLENGE_TIMEOUT;
    let mut solved = false;

    while Instant::now() < deadline {
        // The window going away means the person closed it: their answer is no.
        let current = match window.url() {
            Ok(current) => current,
            Err(_) => break,
        };
        if navigation
            .lock()
            .unwrap()
            .observe(&current, started.elapsed())
        {
            landed = current;
            solved = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let cookies = if solved {
        // The loaded destination has already settled. Read only this site's
        // cookies, and report read failures rather than claiming clearance.
        window
            .cookies_for_url(landed.clone())
            .map(|jar| {
                jar.into_iter()
                    .map(|c| CookieOut {
                        name: c.name().to_string(),
                        value: c.value().to_string(),
                    })
                    .collect::<Vec<_>>()
            })
            .map_err(|e| format!("Could not read verification cookies: {e}. Try again."))
    } else {
        Ok(Vec::new())
    };

    let _ = window.close();
    Ok(ChallengeOutcome {
        solved,
        cookies: cookies?,
        landed_on: landed.to_string(),
    })
}

fn main() {
    let port = free_port();

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(Sidecar {
            child: Mutex::new(None),
            port,
            api_key: uuid::Uuid::new_v4().simple().to_string(),
        })
        .invoke_handler(tauri::generate_handler![
            api_base,
            api_key,
            validate_update_restart,
            open_challenge,
            open_external
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let data_dir = std::env::var_os("FLYSCAN_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(handle.path().app_local_data_dir()?);
            fs::create_dir_all(&data_dir)?;
            let log_path = data_dir.join("sidecar.log");
            if fs::metadata(&log_path).is_ok_and(|m| m.len() > 2 * 1024 * 1024) {
                let _ = fs::copy(&log_path, data_dir.join("sidecar.previous.log"));
                let _ = fs::File::create(&log_path);
            }
            let log = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)?;
            let path = sidecar_path(&handle)
                .ok_or("The bundled flight service is missing. Please reinstall Flyscan.")?;
            // The window-destroyed handler below is the tidy exit. This
            // is the other half: Ctrl+C in a `tauri dev` terminal, a
            // crash, or a rebuild kills us with no window event at all,
            // and an orphaned sidecar then holds the port, the database
            // and its own binary — which makes the *next* build fail
            // deleting a locked file. Watching from both ends is what
            // makes that impossible rather than merely unlikely.
            let mut command = Command::new(&path);
            command
                .current_dir(&data_dir)
                .env("FLYSCAN_API_KEY", &app.state::<Sidecar>().api_key)
                .env("PYTHONUNBUFFERED", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.try_clone()?))
                .stderr(Stdio::from(log))
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--db")
                .arg(data_dir.join("flights.db"))
                .arg("--port")
                .arg(port.to_string())
                .arg("--exit-with-parent")
                .arg(std::process::id().to_string());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            let mut child = command.spawn().map_err(|e| {
                format!(
                    "Could not start the flight service: {e}. Log: {}",
                    log_path.display()
                )
            })?;
            if let Err(error) = wait_for_sidecar(&mut child, port, &app.state::<Sidecar>().api_key)
            {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{error}\n\nDetails: {}", log_path.display()).into());
            }
            *app.state::<Sidecar>().child.lock().unwrap() = Some(child);
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // The sidecar is ours; it should not outlive the window.
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    if let Some(state) = window.app_handle().try_state::<Sidecar>() {
                        if let Some(mut child) = state.child.lock().unwrap().take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!());
    if let Err(error) = result {
        startup_error(&format!("{error}\n\nTry reinstalling the app. Your saved searches are kept in your local app data folder."));
        std::process::exit(1);
    }
}
