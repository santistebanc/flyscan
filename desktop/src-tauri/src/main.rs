//! Desktop shell for the flight scraper.
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

use std::net::TcpListener;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// Marker in a challenge URL. Leaving this page is the signal it was cleared —
/// more reliable than trying to read anything on it.
const CHECK_MARKER: &str = "/security/check";

/// How long to let someone work on a challenge before giving up on them.
const CHALLENGE_TIMEOUT: Duration = Duration::from_secs(300);
static CHALLENGE_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);

struct Sidecar {
    child: Mutex<Option<Child>>,
    port: u16,
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
    if let Ok(explicit) = std::env::var("FLIGHT_SCRAPER_SIDECAR") {
        return Some(explicit.into());
    }
    let name = if cfg!(windows) {
        "flight-scraper-sidecar.exe"
    } else {
        "flight-scraper-sidecar"
    };
    // Bundled next to the executable...
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join(name);
        if bundled.exists() {
            return Some(bundled);
        }
    }
    // ...or built into packaging/dist while developing.
    let dev = std::env::current_dir()
        .ok()?
        .join("../../packaging/dist")
        .join(name);
    dev.exists().then_some(dev)
}

/// The sidecar's base URL, so the frontend does not have to guess the port.
#[tauri::command]
fn api_base(sidecar: State<'_, Sidecar>) -> String {
    format!("http://127.0.0.1:{}", sidecar.port)
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
    let parsed = url.parse().map_err(|_| format!("not a URL: {url}"))?;

    let label = format!(
        "challenge-{}",
        CHALLENGE_WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(parsed))
        .title("Security check — solve this to continue")
        .inner_size(560.0, 720.0)
        .center()
        .focused(true)
        .build()
        .map_err(|e| format!("could not open the challenge window: {e}"))?;

    let deadline = Instant::now() + CHALLENGE_TIMEOUT;
    let mut landed = url.clone();
    let mut solved = false;

    while Instant::now() < deadline {
        // The window going away means the person closed it: their answer is no.
        let current = match window.url() {
            Ok(current) => current.to_string(),
            Err(_) => break,
        };
        if !current.contains(CHECK_MARKER) {
            landed = current;
            solved = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let cookies = if solved {
        // Let the redirect settle so every cookie is set before reading.
        tokio::time::sleep(Duration::from_millis(2000)).await;
        window
            .cookies()
            .map(|jar| {
                jar.into_iter()
                    .map(|c| CookieOut {
                        name: c.name().to_string(),
                        value: c.value().to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let _ = window.close();
    Ok(ChallengeOutcome {
        solved,
        cookies,
        landed_on: landed,
    })
}

fn main() {
    let port = free_port();

    tauri::Builder::default()
        .manage(Sidecar {
            child: Mutex::new(None),
            port,
        })
        .invoke_handler(tauri::generate_handler![
            api_base,
            open_challenge,
            open_external
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            match sidecar_path(&handle) {
                Some(path) => {
                    // The window-destroyed handler below is the tidy exit. This
                    // is the other half: Ctrl+C in a `tauri dev` terminal, a
                    // crash, or a rebuild kills us with no window event at all,
                    // and an orphaned sidecar then holds the port, the database
                    // and its own binary — which makes the *next* build fail
                    // deleting a locked file. Watching from both ends is what
                    // makes that impossible rather than merely unlikely.
                    let child = Command::new(&path)
                        .arg("--port")
                        .arg(port.to_string())
                        .arg("--exit-with-parent")
                        .arg(std::process::id().to_string())
                        .spawn()
                        .map_err(|e| format!("could not start the sidecar at {path:?}: {e}"))?;
                    *app.state::<Sidecar>().child.lock().unwrap() = Some(child);
                }
                None => {
                    // Not fatal: a developer may be running the sidecar by hand.
                    eprintln!(
                        "sidecar binary not found — build it with packaging/README.md, \
                         or set FLIGHT_SCRAPER_SIDECAR"
                    );
                }
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
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the desktop shell");
}
