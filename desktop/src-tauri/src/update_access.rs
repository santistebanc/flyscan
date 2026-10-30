//! Keep the private update password encrypted for the current Windows user.
use std::fs;
use tauri::{AppHandle, Manager, WebviewWindow};

pub fn private_edition() -> bool {
    option_env!("FLYSCAN_EDITION") == Some("private")
}

fn check_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Update credentials are available only in the main window.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn update_edition(window: WebviewWindow) -> Result<bool, String> {
    check_window(&window)?;
    Ok(private_edition())
}

#[tauri::command]
pub fn update_password(app: AppHandle, window: WebviewWindow) -> Result<Option<String>, String> {
    check_window(&window)?;
    if !private_edition() {
        return Ok(None);
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not locate app data")?
        .join("update-access.bin");
    if !path.exists() {
        return Ok(None);
    }
    let encrypted = fs::read(path).map_err(|_| "Could not read update access")?;
    let plain = protect(&encrypted, false)?;
    String::from_utf8(plain)
        .map(Some)
        .map_err(|_| "Update access is invalid. Enter the password again.".into())
}

#[tauri::command]
pub fn save_update_password(
    app: AppHandle,
    window: WebviewWindow,
    password: String,
) -> Result<(), String> {
    check_window(&window)?;
    if !private_edition() {
        return Err("This is the public edition.".into());
    }
    if password.len() > 512 || password.contains(['\r', '\n']) {
        return Err("Password is invalid.".into());
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not locate app data")?;
    let path = directory.join("update-access.bin");
    if password.is_empty() {
        if path.exists() {
            fs::remove_file(path).map_err(|_| "Could not forget password")?;
        }
        return Ok(());
    }
    let encrypted = protect(password.as_bytes(), true)?;
    fs::create_dir_all(&directory).map_err(|_| "Could not create app data")?;
    fs::write(path, encrypted).map_err(|_| "Could not save update access".into())
}

#[cfg(windows)]
fn protect(input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;
    #[repr(C)]
    struct Blob {
        length: u32,
        data: *mut u8,
    }
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    let source = Blob {
        length: input.len() as u32,
        data: input.as_ptr() as *mut u8,
    };
    let mut output = Blob {
        length: 0,
        data: std::ptr::null_mut(),
    };
    // CRYPTPROTECT_UI_FORBIDDEN: no credential dialogs can stall background checks.
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &source,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &source,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("Windows could not unlock update access. Enter the password again.".into());
    }
    let value = unsafe { std::slice::from_raw_parts(output.data, output.length as usize).to_vec() };
    unsafe {
        LocalFree(output.data.cast());
    }
    Ok(value)
}

#[cfg(not(windows))]
fn protect(_: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("Private update password storage is supported by the Windows edition.".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::protect;
    #[test]
    fn private_update_password_round_trips_through_windows_user_encryption() {
        let password = b"test-only-private-update-password";
        let encrypted = protect(password, true).unwrap();
        assert_ne!(encrypted, password);
        assert_eq!(protect(&encrypted, false).unwrap(), password);
        assert!(protect(b"not-a-windows-protected-blob", false).is_err());
    }
}
