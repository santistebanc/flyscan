//! Verify the distributed bytes against the same public key embedded in the app.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        return Err("Usage: verify-artifact tauri.conf.json installer.exe installer.exe.sig".into());
    }
    let config: serde_json::Value = serde_json::from_slice(&fs::read(&args[1])?)?;
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("Missing update public key")?;
    let key = String::from_utf8(STANDARD.decode(key.trim())?)?;
    let signature = String::from_utf8(STANDARD.decode(fs::read_to_string(&args[3])?.trim())?)?;
    PublicKey::decode(&key)?.verify(
        &fs::read(&args[2])?,
        &Signature::decode(&signature)?,
        false,
    )?;
    println!("Update signature verified against the app's embedded public key.");
    Ok(())
}
