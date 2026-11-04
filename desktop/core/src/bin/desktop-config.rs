//! Explicit local connection import for installers and administration.
//! Credentials are read from a private input file and never printed.
use std::{path::PathBuf, sync::Arc};
use swift_desktop_core::{
    connection::{ConnectInput, Connection},
    storage::{NativeVault, Store, Vault},
};
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1)
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err(
            "Usage: desktop-config PRIVATE_CONNECTION_FILE APPLICATION_DATA_DIRECTORY".into(),
        );
    }
    let entries: Vec<ConnectInput> = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let mut candidates = Vec::new();
    for input in entries {
        candidates.push(Connection::create(input).await?);
    }
    let mut store = Store::open(&PathBuf::from(&args[2]))?;
    let vault = Arc::new(NativeVault);
    let mut settings = store.settings.clone();
    for connection in candidates {
        if connection.token.is_empty() {
            vault.remove(&connection.profile.id)?;
        } else {
            vault.set(&connection.profile.id, connection.token.as_str())?;
        }
        settings.profiles.retain(|p| p.id != connection.profile.id);
        settings.profiles.push(connection.profile);
    }
    if !settings.active.as_ref().is_some_and(|id| {
        settings
            .profiles
            .iter()
            .any(|p| &p.id == id && p.mode == "direct")
    }) {
        settings.active = settings
            .profiles
            .iter()
            .find(|p| p.mode == "direct")
            .map(|p| p.id.clone());
    }
    store.save(settings)?;
    println!(
        "{{\"ok\":true,\"directConnections\":{}}}",
        store
            .settings
            .profiles
            .iter()
            .filter(|p| p.mode == "direct")
            .count()
    );
    Ok(())
}
