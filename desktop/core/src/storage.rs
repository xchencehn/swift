use crate::error::{ClientError, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub mode: String,
    pub address: String,
    pub remote_base: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    pub profiles: Vec<Profile>,
    pub active: Option<String>,
}
pub trait Vault: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<String>>;
    fn set(&self, id: &str, secret: &str) -> Result<()>;
    fn remove(&self, id: &str) -> Result<()>;
}
pub struct NativeVault;
/// Development instances retain the real system vault without sharing credential identifiers.
pub struct ScopedVault {
    inner: std::sync::Arc<dyn Vault>,
    prefix: String,
}
impl ScopedVault {
    pub fn new(inner: std::sync::Arc<dyn Vault>, scope: &Path) -> Self {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(scope.to_string_lossy().as_bytes());
        Self {
            inner,
            prefix: format!(
                "development-{}-",
                digest
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            ),
        }
    }
}
impl Vault for ScopedVault {
    fn get(&self, id: &str) -> Result<Option<String>> {
        self.inner.get(&format!("{}{id}", self.prefix))
    }
    fn set(&self, id: &str, secret: &str) -> Result<()> {
        self.inner.set(&format!("{}{id}", self.prefix), secret)
    }
    fn remove(&self, id: &str) -> Result<()> {
        self.inner.remove(&format!("{}{id}", self.prefix))
    }
}
#[cfg(any(target_os = "windows", target_os = "macos"))]
impl Vault for NativeVault {
    fn get(&self, id: &str) -> Result<Option<String>> {
        let entry = keyring::Entry::new("io.agentstudio.swift.desktop", id)
            .map_err(|_| ClientError::storage())?;
        #[cfg(target_os = "windows")]
        match entry.get_secret() {
            Ok(bytes) => {
                let bytes = zeroize::Zeroizing::new(bytes);
                if let Some(value) = bytes.strip_prefix(b"swift-vault-v1\0") {
                    return String::from_utf8(value.to_vec())
                        .map(Some)
                        .map_err(|_| ClientError::storage());
                }
                // Existing releases used keyring's UTF-16 password encoding.
            }
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(_) => return Err(ClientError::storage()),
        }
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(ClientError::storage()),
        }
    }
    fn set(&self, id: &str, secret: &str) -> Result<()> {
        let entry = keyring::Entry::new("io.agentstudio.swift.desktop", id)
            .map_err(|_| ClientError::storage())?;
        #[cfg(target_os = "windows")]
        {
            // CREDENTIAL_BLOB is limited in bytes. set_password doubles ASCII JSON
            // into UTF-16; store a tagged UTF-8 binary secret instead.
            if secret.encode_utf16().count() * 2 <= 2560 {
                // Keep existing small credentials readable by older clients during rollback.
                return entry
                    .set_password(secret)
                    .map_err(|_| ClientError::storage());
            }
            let mut bytes = zeroize::Zeroizing::new(b"swift-vault-v1\0".to_vec());
            bytes.extend_from_slice(secret.as_bytes());
            entry.set_secret(&bytes).map_err(|_| ClientError::storage())
        }
        #[cfg(target_os = "macos")]
        entry
            .set_password(secret)
            .map_err(|_| ClientError::storage())
    }
    fn remove(&self, id: &str) -> Result<()> {
        match keyring::Entry::new("io.agentstudio.swift.desktop", id)
            .map_err(|_| ClientError::storage())?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(ClientError::storage()),
        }
    }
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl Vault for NativeVault {
    fn get(&self, _id: &str) -> Result<Option<String>> {
        Err(ClientError::storage())
    }
    fn set(&self, _id: &str, _secret: &str) -> Result<()> {
        Err(ClientError::storage())
    }
    fn remove(&self, _id: &str) -> Result<()> {
        Ok(())
    }
}
// Explicitly used by disposable harnesses, never selected by the desktop application.
#[derive(Default)]
pub struct MemoryVault(Mutex<HashMap<String, String>>);
impl Vault for MemoryVault {
    fn get(&self, id: &str) -> Result<Option<String>> {
        Ok(self
            .0
            .lock()
            .map_err(|_| ClientError::storage())?
            .get(id)
            .cloned())
    }
    fn set(&self, id: &str, secret: &str) -> Result<()> {
        self.0
            .lock()
            .map_err(|_| ClientError::storage())?
            .insert(id.into(), secret.into());
        Ok(())
    }
    fn remove(&self, id: &str) -> Result<()> {
        self.0
            .lock()
            .map_err(|_| ClientError::storage())?
            .remove(id);
        Ok(())
    }
}
pub struct Store {
    path: PathBuf,
    pub settings: Settings,
}
impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        fs::create_dir_all(directory).map_err(|_| ClientError::storage())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| ClientError::storage())?;
        }
        let path = directory.join("connections.json");
        let settings: Settings = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| ClientError::storage())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(_) => return Err(ClientError::storage()),
        };
        if settings.profiles.len() > 64
            || settings.profiles.iter().any(|p| {
                !valid_id(&p.id)
                    || !["direct", "remote", "paired", "account"].contains(&p.mode.as_str())
                    || p.name.len() > 320
            })
        {
            return Err(ClientError::storage());
        }
        Ok(Self { path, settings })
    }
    pub fn save(&mut self, next: Settings) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(&next).map_err(|_| ClientError::storage())?;
        let temp = self.path.with_extension("tmp");
        {
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&temp)
                .map_err(|_| ClientError::storage())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o600))
                    .map_err(|_| ClientError::storage())?;
            }
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| ClientError::storage())?;
        }
        // Windows rename replaces a file via MoveFileEx in Rust's implementation.
        fs::rename(&temp, &self.path).map_err(|_| ClientError::storage())?;
        self.settings = next;
        Ok(())
    }
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod isolated_vault_tests {
    use super::*;
    #[test]
    fn development_accounts_cannot_read_or_remove_installed_client_credentials() {
        let native = std::sync::Arc::new(MemoryVault::default());
        let first = ScopedVault::new(native.clone(), Path::new("/isolated/first"));
        let second = ScopedVault::new(native.clone(), Path::new("/isolated/second"));
        let key = "swift-official-account-v1";
        native.set(key, "installed-credential").unwrap();
        first.set(key, "development-credential").unwrap();
        assert_eq!(second.get(key).unwrap(), None);
        first.remove(key).unwrap();
        assert_eq!(
            native.get(key).unwrap().as_deref(),
            Some("installed-credential")
        );
    }
}
