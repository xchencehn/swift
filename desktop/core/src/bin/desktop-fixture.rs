//! Disposable harness entry. The installed application never uses a memory vault.
use std::{path::PathBuf, sync::Arc};
use swift_desktop_core::{gateway, storage::MemoryVault};
#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    if std::env::args().nth(1).as_deref() == Some("--vault-check") {
        use swift_desktop_core::storage::{NativeVault, Vault};
        let id = format!("swift-vault-validation-{}", std::process::id());
        let entry = keyring::Entry::new("io.agentstudio.swift.desktop", &id).unwrap();
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            entry.set_password("legacy-utf16-fixture")?;
            assert_eq!(
                NativeVault.get(&id)?.as_deref(),
                Some("legacy-utf16-fixture")
            );
            let value = "v".repeat(2000);
            NativeVault.set(&id, &value)?;
            assert_eq!(NativeVault.get(&id)?.as_deref(), Some(value.as_str()));
            assert!(entry.get_secret()?.len() <= 2560);
            NativeVault.remove(&id)?;
            assert!(NativeVault.get(&id)?.is_none());
            Ok(())
        })();
        let _ = entry.delete_credential();
        result.unwrap();
        println!("{{\"ok\":true,\"legacyUtf16Read\":true,\"binaryUtf8Write\":true,\"largeCredentialColdRead\":true,\"removed\":true}}");
        return;
    }
    let args: Vec<_> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: desktop-fixture PRIVATE_TEMP_DIRECTORY [PORT]");
        std::process::exit(1);
    }
    let port = args
        .get(2)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    let gateway = gateway::start(
        &PathBuf::from(&args[1]),
        port,
        Arc::new(MemoryVault::default()),
    )
    .await
    .expect("fixture start");
    println!(
        "{}",
        serde_json::json!({"origin":gateway.origin,"bootstrap":gateway.bootstrap_url})
    );
    let _ = tokio::signal::ctrl_c().await;
    gateway.stop();
}
