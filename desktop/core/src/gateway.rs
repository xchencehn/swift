use crate::{
    connection::{ConnectInput, Connection},
    error::{ClientError, Result},
    storage::{Profile, Store, Vault},
};
use axum::{
    body::Body,
    extract::{
        ws::{CloseFrame, Message, WebSocket},
        DefaultBodyLimit, State, WebSocketUpgrade,
    },
    http::{header, HeaderMap, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use include_dir::{include_dir, Dir};
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    sync::{watch, Mutex as AsyncMutex},
};
use tokio_tungstenite::{
    tungstenite::{client::IntoClientRequest, Message as RemoteMessage},
    Connector,
};

static ASSETS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../dist");
pub const DEFAULT_PORT: u16 = 17492;
pub fn open_external(url: &str) -> std::io::Result<()> {
    webbrowser::open(url)
}
pub struct Gateway {
    pub origin: String,
    pub bootstrap_url: String,
    pub state: Arc<GatewayState>,
    pub task: tokio::task::JoinHandle<()>,
}
pub struct GatewayState {
    origin: String,
    session: String,
    bootstrapped: AtomicBool,
    store: Mutex<Store>,
    vault: Arc<dyn Vault>,
    connections: Mutex<HashMap<String, (Connection, watch::Sender<()>)>>,
    operations: AsyncMutex<()>,
    updates: Mutex<Option<Arc<dyn crate::updates::NativeUpdates>>>,
    diagnostics: crate::diagnostics::Diagnostics,
}
fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub async fn start(directory: &Path, port: u16, vault: Arc<dyn Vault>) -> Result<Gateway> {
    let store = Store::open(directory)?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|_| {
            ClientError(
                StatusCode::CONFLICT,
                "CLIENT_PORT_OCCUPIED",
                "Swift 客户端端口已被占用，请关闭另一实例后重试。",
            )
        })?;
    let origin = format!(
        "http://127.0.0.1:{}",
        listener
            .local_addr()
            .map_err(|_| ClientError::network())?
            .port()
    );
    let session = random_secret();
    let state = Arc::new(GatewayState {
        origin: origin.clone(),
        session: session.clone(),
        bootstrapped: AtomicBool::new(false),
        store: Mutex::new(store),
        diagnostics: crate::diagnostics::Diagnostics::new(directory),
        vault,
        connections: Mutex::new(HashMap::new()),
        operations: AsyncMutex::new(()),
        updates: Mutex::new(None),
    });
    let protected = Router::new()
        .route("/", get(home))
        .route("/connect", get(connect_page))
        .route("/desktop/profiles", get(profiles))
        .route(
            "/desktop/connection-diagnostics",
            get(connection_diagnostics_read)
                .post(connection_diagnostics)
                .layer(DefaultBodyLimit::max(512)),
        )
        .route("/desktop/connect", post(connect))
        .route("/desktop/activate", post(activate))
        .route("/desktop/update", post(update_connection))
        .route("/desktop/remove", post(remove))
        .route("/desktop/update/check", post(check_update))
        .route("/desktop/update/install", post(install_update))
        .route("/desktop/{*path}", get(desktop_asset))
        .route("/e/{id}", get(frontend))
        .route("/e/{id}/", get(frontend))
        .route(
            "/e/{id}/{*path}",
            get(frontend)
                .post(frontend)
                .put(frontend)
                .delete(frontend)
                .patch(frontend),
        )
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(tower_http::limit::RequestBodyLimitLayer::new(
            64 * 1024 * 1024,
        ))
        .layer(middleware::from_fn_with_state(state.clone(), authorize));
    let router = Router::new()
        .route("/bootstrap/{nonce}", get(bootstrap))
        .merge(protected)
        .with_state(state.clone());
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(Gateway {
        origin: origin.clone(),
        bootstrap_url: format!("{origin}/bootstrap/{session}"),
        state,
        task,
    })
}
impl Gateway {
    pub fn stop(&self) {
        self.state
            .connections
            .lock()
            .expect("connections lock")
            .clear();
        self.task.abort();
    }
    pub fn set_updates(&self, updates: Arc<dyn crate::updates::NativeUpdates>) {
        *self.state.updates.lock().expect("native updates lock") = Some(updates);
    }
}
fn updates(state: &GatewayState) -> Result<Arc<dyn crate::updates::NativeUpdates>> {
    state
        .updates
        .lock()
        .map_err(|_| ClientError::storage())?
        .clone()
        .ok_or(ClientError(
            StatusCode::NOT_IMPLEMENTED,
            "UPDATE_UNAVAILABLE",
            "此测试构建不提供软件更新。",
        ))
}
async fn check_update(State(state): State<Arc<GatewayState>>) -> Result<Json<serde_json::Value>> {
    Ok(Json(updates(&state)?.check().await?))
}
async fn install_update(State(state): State<Arc<GatewayState>>) -> Result<Json<serde_json::Value>> {
    Ok(Json(updates(&state)?.install().await?))
}
fn redirect(location: &str) -> Response {
    (StatusCode::SEE_OTHER, [(header::LOCATION, location)]).into_response()
}
async fn bootstrap(
    State(state): State<Arc<GatewayState>>,
    axum::extract::Path(nonce): axum::extract::Path<String>,
) -> Response {
    if nonce.as_bytes().ct_eq(state.session.as_bytes()).unwrap_u8() != 1
        || state.bootstrapped.swap(true, Ordering::SeqCst)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = redirect("/");
    response.headers_mut().insert(
        header::SET_COOKIE,
        format!(
            "swiftDesktopSession={}; Path=/; HttpOnly; SameSite=Strict",
            state.session
        )
        .parse()
        .unwrap(),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
async fn authorize(
    State(state): State<Arc<GatewayState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let host = state.origin.trim_start_matches("http://");
    if request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        != Some(host)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let cookie = request
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .find_map(|p| p.trim().strip_prefix("swiftDesktopSession="));
    if cookie.map(|value| value.as_bytes().ct_eq(state.session.as_bytes()).unwrap_u8()) != Some(1) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if ![Method::GET, Method::HEAD].contains(request.method())
        || request.headers().contains_key(header::UPGRADE)
    {
        if request
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            != Some(&state.origin)
        {
            return StatusCode::FORBIDDEN.into_response();
        }
    } else if let Some(origin) = request.headers().get(header::ORIGIN) {
        if origin.to_str().ok() != Some(&state.origin) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    let versioned = request.uri().query().is_some_and(|query| {
        url::form_urlencoded::parse(query.as_bytes()).any(|(key, value)| {
            key == "v" && value.len() == 20 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    });
    let not_modified = request.headers().get(header::IF_NONE_MATCH).cloned();
    let mut response = next.run(request).await;
    // Only installed static assets carry an ETag. Documents, credentials and
    // upstream data retain their existing cache and authorization boundaries.
    if let Some(etag) = response.headers().get(header::ETAG) {
        let matches = not_modified.as_ref() == Some(etag);
        if versioned {
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable".parse().unwrap(),
            );
        }
        if matches && response.status() == StatusCode::OK {
            *response.status_mut() = StatusCode::NOT_MODIFIED;
            *response.body_mut() = Body::empty();
            response.headers_mut().remove(header::CONTENT_LENGTH);
        }
    }
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    if !response.headers().contains_key(header::X_FRAME_OPTIONS) {
        response
            .headers_mut()
            .insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    }
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    response
}
fn asset(name: &str, html_base: Option<&str>) -> Result<Response> {
    let file = ASSETS.get_file(name).ok_or(ClientError(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        "资源不存在。",
    ))?;
    let data = if let Some(base) = html_base {
        file.contents_utf8()
            .ok_or_else(ClientError::network)?
            .replace("__AGENT_STUDIO_BASE_PATH__", base)
            .into_bytes()
    } else {
        file.contents().to_vec()
    };
    let mime = mime_guess::from_path(name)
        .first_or_octet_stream()
        .to_string();
    let mut response = (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "no-cache".into()),
        ],
        data,
    )
        .into_response();
    if !name.ends_with(".html") {
        static ETAG: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        let etag = ETAG.get_or_init(|| {
            let metadata: serde_json::Value =
                serde_json::from_slice(ASSETS.get_file("VERSION.json").unwrap().contents())
                    .unwrap();
            format!("\"{}\"", metadata["frontendVersion"].as_str().unwrap())
        });
        response
            .headers_mut()
            .insert(header::ETAG, etag.parse().unwrap());
    }
    // Remote code never receives a native bridge. Only shipped scripts run here.
    response.headers_mut().insert(header::CONTENT_SECURITY_POLICY, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'".parse().unwrap());
    if name == "public/files/html-preview.html" {
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            include_str!("../../../public/files/html-preview.csp")
                .trim()
                .parse()
                .unwrap(),
        );
        response
            .headers_mut()
            .insert(header::X_FRAME_OPTIONS, "SAMEORIGIN".parse().unwrap());
    }
    if name == "public/index.html" && html_base.is_some() {
        response
            .headers_mut()
            .insert(header::X_FRAME_OPTIONS, "SAMEORIGIN".parse().unwrap());
        let csp = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap()
            .replace("frame-ancestors 'none'", "frame-ancestors 'self'");
        response
            .headers_mut()
            .insert(header::CONTENT_SECURITY_POLICY, csp.parse().unwrap());
    }
    Ok(response)
}
async fn home(State(state): State<Arc<GatewayState>>) -> Response {
    let active = state.store.lock().ok().and_then(|store| {
        store.settings.active.clone().filter(|id| {
            store
                .settings
                .profiles
                .iter()
                .any(|p| &p.id == id && p.mode == "direct")
        })
    });
    if let Some(id) = active {
        redirect(&format!("/e/{id}/"))
    } else {
        redirect("/connect")
    }
}

async fn connect_page() -> Result<Response> {
    asset("desktop/index.html", None)
}
async fn desktop_asset(axum::extract::Path(path): axum::extract::Path<String>) -> Result<Response> {
    asset(&format!("desktop/{path}"), None)
}
async fn profiles(State(state): State<Arc<GatewayState>>) -> Result<Json<serde_json::Value>> {
    let store = state.store.lock().map_err(|_| ClientError::storage())?;
    Ok(Json(
        json!({"version":env!("CARGO_PKG_VERSION"),"profiles":store.settings.profiles.iter().filter(|p|p.mode=="direct").collect::<Vec<_>>(),"active":store.settings.active}),
    ))
}
async fn connection_diagnostics_read(
    State(state): State<Arc<GatewayState>>,
) -> Json<Vec<serde_json::Value>> {
    Json(state.diagnostics.snapshot())
}
async fn connection_diagnostics(
    State(state): State<Arc<GatewayState>>,
    Json(event): Json<crate::diagnostics::Event>,
) -> StatusCode {
    if state.diagnostics.record(event) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::BAD_REQUEST
    }
}
async fn select(
    state: &GatewayState,
    connection: Connection,
    write_secret: bool,
) -> Result<Json<serde_json::Value>> {
    {
        let mut store = state.store.lock().map_err(|_| ClientError::storage())?;
        if store
            .settings
            .profiles
            .iter()
            .filter(|p| p.id != connection.profile.id)
            .count()
            >= 64
        {
            return Err(ClientError::invalid());
        }
        let previous = if write_secret {
            state.vault.get(&connection.profile.id)?
        } else {
            None
        };
        if write_secret {
            if connection.token.is_empty() {
                state.vault.remove(&connection.profile.id)?;
            } else {
                state
                    .vault
                    .set(&connection.profile.id, connection.token.as_str())?;
            }
        }
        let mut settings = store.settings.clone();
        settings.profiles.retain(|p| p.id != connection.profile.id);
        settings.profiles.push(connection.profile.clone());
        settings.active = Some(connection.profile.id.clone());
        if let Err(error) = store.save(settings) {
            if write_secret {
                if let Some(secret) = previous {
                    let _ = state.vault.set(&connection.profile.id, &secret);
                } else {
                    let _ = state.vault.remove(&connection.profile.id);
                }
            }
            return Err(error);
        }
    }
    let path = format!("/e/{}/", connection.profile.id);
    let mut connections = state
        .connections
        .lock()
        .map_err(|_| ClientError::storage())?;
    // Selecting another window's connection does not invalidate its live sockets.
    // Replacing credentials invalidates only this profile's old sockets.
    if write_secret || !connections.contains_key(&connection.profile.id) {
        connections.insert(
            connection.profile.id.clone(),
            (connection, watch::channel(()).0),
        );
    }
    Ok(Json(json!({"ok":true,"path":path})))
}
async fn connect(
    State(state): State<Arc<GatewayState>>,
    Json(input): Json<ConnectInput>,
) -> Result<Json<serde_json::Value>> {
    let _operation = state.operations.lock().await;
    let connection = Connection::create(input).await?;
    select(&state, connection, true).await
}
#[derive(Deserialize)]
struct Identity {
    id: String,
}
fn saved(state: &GatewayState, id: &str) -> Result<Profile> {
    state
        .store
        .lock()
        .map_err(|_| ClientError::storage())?
        .settings
        .profiles
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(ClientError::invalid)
}
#[derive(Deserialize)]
struct UpdateInput {
    id: String,
    #[serde(flatten)]
    connection: ConnectInput,
}
async fn update_connection(
    State(state): State<Arc<GatewayState>>,
    Json(mut input): Json<UpdateInput>,
) -> Result<Json<serde_json::Value>> {
    let _operation = state.operations.lock().await;
    let previous = saved(&state, &input.id)?;
    let (address, entered_token) =
        crate::connection::connection_link(&input.connection.address, &input.connection.token)?;
    let same_endpoint = previous.mode == "direct" && address.as_str() == previous.address;
    let previous_secret = state.vault.get(&previous.id)?;
    let credentials_changed = !same_endpoint || !entered_token.is_empty();
    let mut connection = if credentials_changed {
        input.connection.token = if entered_token.is_empty() && same_endpoint {
            previous_secret.clone().unwrap_or_default()
        } else {
            entered_token
        };
        input.connection.address = address.to_string();
        Connection::create(input.connection).await?
    } else {
        let mut profile = previous.clone();
        profile.name = input.connection.name.trim().chars().take(80).collect();
        Connection::restore(profile, previous_secret.clone().unwrap_or_default())?
    };
    if connection.profile.name.is_empty() {
        connection.profile.name = previous.name.clone();
    }
    let id = connection.profile.id.clone();
    {
        let mut store = state.store.lock().map_err(|_| ClientError::storage())?;
        if id != previous.id
            && store
                .settings
                .profiles
                .iter()
                .any(|profile| profile.id == id)
        {
            return Err(ClientError(
                StatusCode::CONFLICT,
                "SERVER_ALREADY_SAVED",
                "这个服务器已存在，请编辑对应的服务器。",
            ));
        }
        let mut next = store.settings.clone();
        let slot = next
            .profiles
            .iter_mut()
            .find(|profile| profile.id == previous.id)
            .ok_or_else(ClientError::invalid)?;
        *slot = connection.profile.clone();
        if next.active.as_ref() == Some(&previous.id) {
            next.active = Some(id.clone());
        }
        // Keep metadata and the native credential store consistent on a failed save.
        let save = (|| {
            if credentials_changed {
                if connection.token.is_empty() {
                    state.vault.remove(&id)?;
                } else {
                    state.vault.set(&id, connection.token.as_str())?;
                }
                if id != previous.id {
                    state.vault.remove(&previous.id)?;
                }
            }
            store.save(next)
        })();
        if let Err(error) = save {
            if credentials_changed {
                if id != previous.id || previous_secret.is_none() {
                    let _ = state.vault.remove(&id);
                }
                if let Some(secret) = previous_secret {
                    let _ = state.vault.set(&previous.id, &secret);
                }
            }
            return Err(error);
        }
    }
    let profile = connection.profile.clone();
    let mut connections = state
        .connections
        .lock()
        .map_err(|_| ClientError::storage())?;
    if credentials_changed || !connections.contains_key(&id) {
        connections.remove(&previous.id);
        connections.insert(id.clone(), (connection, watch::channel(()).0));
    } else if let Some((live, _)) = connections.get_mut(&id) {
        live.profile = profile.clone();
    }
    Ok(Json(
        json!({"ok":true,"profile":profile,"path":format!("/e/{id}/")}),
    ))
}
async fn activate(
    State(state): State<Arc<GatewayState>>,
    Json(input): Json<Identity>,
) -> Result<Json<serde_json::Value>> {
    let _operation = state.operations.lock().await;
    let profile = saved(&state, &input.id)?;
    let token = state.vault.get(&profile.id)?.unwrap_or_default();
    let connection = Connection::restore(profile, token)?;
    connection.verify().await?;
    select(&state, connection, false).await
}
async fn remove(
    State(state): State<Arc<GatewayState>>,
    Json(input): Json<Identity>,
) -> Result<Json<serde_json::Value>> {
    let _operation = state.operations.lock().await;
    saved(&state, &input.id)?;
    {
        let mut store = state.store.lock().map_err(|_| ClientError::storage())?;
        let mut next = store.settings.clone();
        next.profiles.retain(|p| p.id != input.id);
        let was_active = next.active.as_ref() == Some(&input.id);
        if was_active {
            next.active = None;
        }
        let secret = state.vault.get(&input.id)?;
        state.vault.remove(&input.id)?;
        if let Err(error) = store.save(next) {
            if let Some(secret) = secret {
                let _ = state.vault.set(&input.id, &secret);
            }
            return Err(error);
        }
    }
    state
        .connections
        .lock()
        .map_err(|_| ClientError::storage())?
        .remove(&input.id);
    Ok(Json(json!({"ok":true})))
}
// Only native namespace path components are eligible for local UI assets.
fn namespace_path(path: &str) -> Option<(String, String)> {
    let mut rest = path;
    let mut prefix = String::new();
    if let Some(tail) = rest.strip_prefix("/machines/") {
        let (id, suffix) = tail.split_once('/')?;
        if id.len() != 36 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return None;
        }
        prefix.push_str(&format!("/machines/{id}"));
        rest = &path[prefix.len()..];
        let _ = suffix;
    }
    if let Some(tail) = rest.strip_prefix("/herdr-sessions/") {
        let (name, _) = tail.split_once('/')?;
        if name == "."
            || name == ".."
            || name.is_empty()
            || name.len() > 64
            || !name.chars().next()?.is_ascii_alphanumeric()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        {
            return None;
        }
        prefix.push_str(&format!("/herdr-sessions/{name}"));
    }
    Some((prefix.clone(), path[prefix.len()..].to_string()))
}

async fn restore_connection(
    state: &Arc<GatewayState>,
    id: &str,
) -> Result<(Connection, watch::Receiver<()>)> {
    let cached = || -> Result<Option<(Connection, watch::Receiver<()>)>> {
        Ok(state
            .connections
            .lock()
            .map_err(|_| ClientError::storage())?
            .get(id)
            .map(|(connection, changes)| (connection.clone(), changes.subscribe())))
    };
    if let Some(connection) = cached()? {
        return Ok(connection);
    }
    // Serialize with edits/removal so a late credential read cannot restore a
    // removed profile. Subsequent requests use the cache without this lock.
    let _operation = state.operations.lock().await;
    if let Some(connection) = cached()? {
        return Ok(connection);
    }
    let profile = saved(state, id)?;
    let vault = state.vault.clone();
    let connection = tokio::task::spawn_blocking(move || {
        let token = vault.get(&profile.id)?.unwrap_or_default();
        Connection::restore(profile, token)
    })
    .await
    .map_err(|_| ClientError::storage())??;
    let changes = watch::channel(()).0;
    let result = (connection.clone(), changes.subscribe());
    state
        .connections
        .lock()
        .map_err(|_| ClientError::storage())?
        .insert(id.to_owned(), (connection, changes));
    Ok(result)
}

#[axum::debug_handler]
async fn frontend(
    State(state): State<Arc<GatewayState>>,
    upgrade: std::result::Result<
        WebSocketUpgrade,
        axum::extract::ws::rejection::WebSocketUpgradeRejection,
    >,
    request: Request<Body>,
) -> Result<Response> {
    let pieces: Vec<_> = request.uri().path().splitn(4, '/').collect();
    let id = pieces.get(2).copied().unwrap_or("");
    // Installed pages and assets are independent of credentials and the network.
    // Restore only a connection that actually receives an API/WebSocket request.
    if !saved(&state, id).is_ok_and(|profile| profile.mode == "direct") {
        return if request.method() == Method::GET
            && matches!(pieces.get(3).copied().unwrap_or(""), "" | "index.html")
        {
            Ok(redirect("/connect"))
        } else {
            Err(ClientError(
                StatusCode::CONFLICT,
                "CONNECTION_CHANGED",
                "这个连接已移除或凭据不可用，请返回连接设置。",
            ))
        };
    }
    let suffix = format!("/{}", pieces.get(3).copied().unwrap_or(""));
    let (namespace, asset_suffix) = namespace_path(&suffix).ok_or_else(ClientError::invalid)?;
    if pieces.len() == 3 {
        return Ok(redirect(&format!("/e/{id}/")));
    }
    if request.method() == Method::GET && asset_suffix == "/frontend-version.json" {
        let metadata: serde_json::Value =
            serde_json::from_slice(ASSETS.get_file("VERSION.json").unwrap().contents()).unwrap();
        return Ok(Json(json!({"version":metadata["frontendVersion"]})).into_response());
    }
    if request.method() == Method::GET && (asset_suffix == "/" || asset_suffix == "/index.html") {
        return asset("public/index.html", Some(&format!("/e/{id}{namespace}")));
    }
    if request.method() == Method::GET
        && !asset_suffix.starts_with("/api/")
        && !asset_suffix.starts_with("/machines/")
    {
        // A desktop binary uses its installed resources, including when the execution is offline.
        if asset_suffix == "/sw.js" {
            return Ok(([(header::CONTENT_TYPE, "application/javascript"), (header::CACHE_CONTROL, "no-store")], "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.registration.unregister()));").into_response());
        }
        if ASSETS.get_file(format!("public{asset_suffix}")).is_some() {
            return asset(&format!("public{asset_suffix}"), None);
        }
    }
    if !asset_suffix.starts_with("/api/") && !asset_suffix.starts_with("/machines/") {
        return Err(ClientError::invalid());
    }
    let (connection, changes) = restore_connection(&state, id).await?;
    if let Ok(upgrade) = upgrade {
        if asset_suffix != "/api/terminal" {
            return Err(ClientError::invalid());
        }
        let mut remote_url = connection.endpoint(&suffix, request.uri().query())?;
        let scheme = if remote_url.scheme() == "https" {
            "wss"
        } else {
            "ws"
        };
        remote_url
            .set_scheme(scheme)
            .map_err(|_| ClientError::invalid())?;
        let mut remote_request = remote_url
            .as_str()
            .into_client_request()
            .map_err(|_| ClientError::invalid())?;
        if !connection.token.is_empty() {
            remote_request.headers_mut().insert(
                "x-agent-studio-token",
                connection
                    .token
                    .as_str()
                    .parse()
                    .map_err(|_| ClientError::invalid())?,
            );
        }
        for name in ["x-agent-studio-device-id", "sec-websocket-protocol"] {
            if let Some(value) = request.headers().get(name) {
                remote_request.headers_mut().insert(name, value.clone());
            }
        }
        if !remote_request
            .headers()
            .contains_key("x-agent-studio-device-id")
        {
            if let Some(device) = request
                .headers()
                .get(header::COOKIE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .split(';')
                .find_map(|piece| piece.trim().strip_prefix("agentStudioDevice="))
            {
                if let Ok(value) = device.parse() {
                    remote_request
                        .headers_mut()
                        .insert("x-agent-studio-device-id", value);
                }
            }
        }
        let mut limits = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
        limits.max_message_size = Some(2 * 1024 * 1024);
        limits.max_frame_size = Some(2 * 1024 * 1024);
        let (remote, _) = tokio::time::timeout(
            Duration::from_secs(12),
            tokio_tungstenite::connect_async_tls_with_config(
                remote_request,
                Some(limits),
                // Terminal input and flow acknowledgements are small, interactive messages.
                true,
                Some(Connector::Rustls(connection.websocket_tls.clone())),
            ),
        )
        .await
        .map_err(|_| ClientError::network())?
        .map_err(|error| match error {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                crate::connection::status_error(response.status().as_u16())
            }
            _ => ClientError::network(),
        })?;
        return Ok(upgrade
            .max_message_size(2 * 1024 * 1024)
            .on_upgrade(move |socket| bridge(socket, remote, changes))
            .into_response());
    }
    let (parts, body) = request.into_parts();
    // Auth comes from the selected native connection. Browser cookies/credentials never travel upstream.
    let query = parts.uri.query().map(|q| {
        url::form_urlencoded::parse(q.as_bytes())
            .into_owned()
            .filter(|(key, _)| key != "token")
            .collect::<Vec<_>>()
    });
    let clean_query = query.map(|pairs| {
        let mut s = url::form_urlencoded::Serializer::new(String::new());
        s.extend_pairs(pairs);
        s.finish()
    });
    let mut upstream = connection.client.request(
        parts.method,
        connection.endpoint(&suffix, clean_query.as_deref())?,
    );
    for name in [
        "content-type",
        "accept",
        "accept-encoding",
        "range",
        "if-none-match",
        "x-agent-studio-device-id",
    ] {
        if let Some(value) = parts.headers.get(name) {
            upstream = upstream.header(name, value);
        }
    }
    if !connection.token.is_empty() {
        upstream = upstream.header("x-agent-studio-token", connection.token.as_str());
    }
    let response = upstream
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await
        .map_err(|_| ClientError::network())?;
    let status = response.status();
    let mut headers = HeaderMap::new();
    for name in [
        "content-type",
        "content-encoding",
        "vary",
        "content-disposition",
        "content-range",
        "accept-ranges",
        "etag",
    ] {
        if let Some(value) = response.headers().get(name) {
            headers.insert(name, value.clone());
        }
    }
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        "default-src 'none'; sandbox".parse().unwrap(),
    );
    Ok((status, headers, Body::from_stream(response.bytes_stream())).into_response())
}
async fn bridge<S>(
    socket: WebSocket,
    remote: tokio_tungstenite::WebSocketStream<S>,
    mut changes: watch::Receiver<()>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut local_send, mut local_read) = socket.split();
    let (mut remote_send, mut remote_read) = remote.split();
    // Sink backpressure is awaited; no unbounded terminal queue or detached per-frame tasks.
    let forward = async {
        while let Some(Ok(message)) = local_read.next().await {
            let message = match message {
                Message::Text(v) => RemoteMessage::Text(v.to_string().into()),
                Message::Binary(v) => RemoteMessage::Binary(v),
                Message::Ping(v) => RemoteMessage::Ping(v),
                Message::Pong(v) => RemoteMessage::Pong(v),
                Message::Close(_) => break,
            };
            if remote_send.send(message).await.is_err() {
                break;
            }
        }
        let _ = remote_send.close().await;
    };
    let backward = async {
        while let Some(Ok(message)) = remote_read.next().await {
            let message = match message {
                RemoteMessage::Text(v) => Message::Text(v.to_string().into()),
                RemoteMessage::Binary(v) => Message::Binary(v),
                RemoteMessage::Ping(v) => Message::Ping(v),
                RemoteMessage::Pong(v) => Message::Pong(v),
                RemoteMessage::Close(frame) => {
                    return frame
                        .map(|frame| CloseFrame {
                            code: frame.code.into(),
                            reason: frame.reason.to_string().into(),
                        })
                        .unwrap_or(CloseFrame {
                            code: 1011,
                            reason: "upstream closed without status".into(),
                        })
                }
                RemoteMessage::Frame(_) => continue,
            };
            if local_send.send(message).await.is_err() {
                break;
            }
        }
        CloseFrame {
            code: 1011,
            reason: "upstream connection ended".into(),
        }
    };
    let close = tokio::select! {
        _ = forward => None,
        frame = backward => Some(frame),
        _ = changes.changed() => Some(CloseFrame { code: 1008, reason: "connection settings changed".into() }),
    };
    if let Some(frame) = close {
        let _ = local_send.send(Message::Close(Some(frame))).await;
    }
}

#[cfg(test)]
mod namespace_tests {
    use super::*;
    #[test]
    fn html_preview_is_isolated_without_weakening_the_app() {
        let report = asset("public/files/html-preview.html", None).unwrap();
        let policy = report
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(policy.contains("sandbox allow-scripts;"));
        assert!(!policy.contains("allow-same-origin"));
        assert!(policy.contains("connect-src 'none'"));
        assert!(policy.contains("frame-src 'none'"));
        let app = asset("public/index.html", Some("")).unwrap();
        assert!(app
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap()
            .contains("script-src 'self';"));
    }
    #[test]
    fn session_paths_keep_assets_local_and_controls_in_their_namespace() {
        assert_eq!(
            namespace_path("/herdr-sessions/work/api/terminal"),
            Some(("/herdr-sessions/work".into(), "/api/terminal".into()))
        );
        assert_eq!(
            namespace_path(
                "/machines/12345678-1234-1234-1234-123456789abc/herdr-sessions/work/style.css"
            ),
            Some((
                "/machines/12345678-1234-1234-1234-123456789abc/herdr-sessions/work".into(),
                "/style.css".into()
            ))
        );
        assert_eq!(namespace_path("/herdr-sessions/../api/config"), None);
        assert_eq!(
            namespace_path("/herdr-sessions/work%2fescape/api/config"),
            None
        );
    }
}
