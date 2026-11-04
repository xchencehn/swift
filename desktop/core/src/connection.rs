use crate::{
    error::{ClientError, Result},
    storage::Profile,
};
use reqwest::Client;
use rustls::{ClientConfig, RootCertStore};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use url::Url;
use zeroize::Zeroizing;
#[derive(Deserialize)]
pub struct ConnectInput {
    pub mode: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub name: String,
}
#[derive(Clone)]
pub struct Connection {
    pub profile: Profile,
    pub client: Client,
    pub websocket_tls: Arc<ClientConfig>,
    pub token: Arc<Zeroizing<String>>,
}
pub fn normalize(value: &str) -> Result<Url> {
    if value.len() > 6144 {
        return Err(ClientError::invalid());
    }
    let mut url = Url::parse(value).map_err(|_| ClientError::invalid())?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ClientError::invalid());
    }
    url.set_path(&format!("{}/", url.path().trim_end_matches('/')));
    Ok(url)
}
pub fn connection_link(value: &str, explicit: &str) -> Result<(Url, String)> {
    let mut url = Url::parse(value).map_err(|_| ClientError::invalid())?;
    let mut token = explicit.to_owned();
    for (key, value) in url.query_pairs() {
        if key != "token" || (!token.is_empty() && token != value) {
            return Err(ClientError::invalid());
        }
        token = value.into_owned();
    }
    url.set_query(None);
    if let Some(fragment) = url.fragment() {
        let value = fragment
            .strip_prefix("token=")
            .ok_or_else(ClientError::invalid)?;
        if !token.is_empty() && token != value {
            return Err(ClientError::invalid());
        }
        token = value.to_owned();
    }
    url.set_fragment(None);
    if token.len() > 4096 || !token.bytes().all(|b| (33..=126).contains(&b)) {
        return Err(ClientError::invalid());
    }
    Ok((normalize(url.as_str())?, token))
}
pub(crate) fn clients() -> Result<(Client, Arc<ClientConfig>)> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let http = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(120));
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Ok((
        http.build().map_err(|_| ClientError::network())?,
        Arc::new(
            ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        ),
    ))
}
pub fn status_error(status: u16) -> ClientError {
    match status {
        401 | 403 => ClientError::unauthorized(),
        503 => ClientError::offline(),
        _ => ClientError::network(),
    }
}
pub(crate) async fn read_json(response: reqwest::Response) -> Result<serde_json::Value> {
    if !response.status().is_success() {
        return Err(status_error(response.status().as_u16()));
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ClientError::network())? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(ClientError::network());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ClientError::network())
}
impl Connection {
    pub async fn create(input: ConnectInput) -> Result<Self> {
        if !["direct", "local", "wsl", "lan"].contains(&input.mode.as_str()) {
            return Err(ClientError::invalid());
        }
        let (url, token) = connection_link(&input.address, &input.token)?;
        let remote_base = url.path().trim_end_matches('/').to_owned();
        // Preserve existing direct profile identities and their per-window drafts.
        let id = format!(
            "{:x}",
            Sha256::digest(format!(
                "direct|{}|{}",
                url.origin().ascii_serialization(),
                remote_base
            ))
        );
        let profile = Profile {
            id,
            name: if input.name.trim().is_empty() {
                url.host_str().unwrap_or("服务器").to_owned()
            } else {
                input.name.trim().chars().take(80).collect()
            },
            mode: "direct".into(),
            address: url.to_string(),
            remote_base,
        };
        let connection = Self::restore(profile, token)?;
        connection.verify().await?;
        Ok(connection)
    }
    pub fn restore(profile: Profile, token: String) -> Result<Self> {
        if profile.mode != "direct" {
            return Err(ClientError::invalid());
        }
        normalize(&profile.address)?;
        let (client, websocket_tls) = clients()?;
        Ok(Self {
            profile,
            client,
            websocket_tls,
            token: Arc::new(Zeroizing::new(token)),
        })
    }
    pub fn endpoint(&self, suffix: &str, query: Option<&str>) -> Result<Url> {
        if !suffix.starts_with('/') || suffix.contains('\\') {
            return Err(ClientError::invalid());
        }
        let mut url = Url::parse(&self.profile.address).map_err(|_| ClientError::invalid())?;
        url.set_path(&format!("{}{}", self.profile.remote_base, suffix));
        url.set_query(query);
        Ok(url)
    }
    pub async fn verify(&self) -> Result<()> {
        let request = self
            .client
            .get(self.endpoint("/api/config", None)?)
            .header("x-agent-studio-token", self.token.as_str())
            .timeout(Duration::from_secs(20));
        let body = read_json(request.send().await.map_err(|_| ClientError::network())?).await?;
        if body["ok"] != true || body["role"] != "execution" {
            return Err(ClientError::network());
        }
        Ok(())
    }
}
