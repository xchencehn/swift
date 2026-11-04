use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use swift_desktop_core::{
    connection::{normalize, ConnectInput, Connection},
    gateway,
    storage::{MemoryVault, Profile, Settings, Store, Vault},
};

fn directory(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "swift-desktop-{name}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
#[test]
fn addresses_reject_embedded_credentials_queries_and_fragments() {
    for value in [
        "file:///private",
        "https://user:password@example.org/",
        "http://localhost/?token=example",
        "http://localhost/#secret",
        "javascript:alert(1)",
    ] {
        assert!(normalize(value).is_err());
    }
    assert!(normalize("http://public.example/").is_ok());
    assert!(normalize("https://example.org/prefix").is_ok());
    assert_eq!(
        normalize("http://localhost:8792/swift").unwrap().as_str(),
        "http://localhost:8792/swift/"
    );
    assert!(normalize("https://example.org/").is_ok());
}
#[tokio::test]
async fn connecting_never_follows_a_redirect_with_credentials() {
    use axum::{routing::get, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let followed = Arc::new(AtomicUsize::new(0));
    let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let destination = format!("http://{}/api/config", target.local_addr().unwrap());
    let counter = followed.clone();
    let target_task = tokio::spawn(async move {
        let router = Router::new().route(
            "/api/config",
            get(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                async { axum::Json(serde_json::json!({"ok":true,"role":"execution"})) }
            }),
        );
        axum::serve(target, router).await.unwrap();
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = Router::new().route(
        "/api/config",
        get(move |headers: axum::http::HeaderMap| async move {
            assert_eq!(headers["x-agent-studio-token"], "fixture-access-token");
            (axum::http::StatusCode::FOUND, [("location", destination)])
        }),
    );
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let input = ConnectInput {
        mode: "direct".into(),
        address: format!("http://127.0.0.1:{port}"),
        token: "fixture-access-token".into(),
        name: String::new(),
    };
    assert!(Connection::create(input).await.is_err());
    assert_eq!(followed.load(Ordering::SeqCst), 0);
    task.abort();
    target_task.abort();
}
#[test]
fn metadata_survives_a_cold_start_and_contains_no_secret() {
    let directory = directory("store");
    let mut store = Store::open(&directory).unwrap();
    let id = "a".repeat(64);
    let profile = Profile {
        id: id.clone(),
        name: "我的电脑".into(),
        mode: "direct".into(),
        address: "http://127.0.0.1:8792/swift/".into(),
        remote_base: "/swift".into(),
    };
    store
        .save(Settings {
            profiles: vec![profile],
            active: Some(id.clone()),
        })
        .unwrap();
    let restored = Store::open(&directory).unwrap();
    assert_eq!(restored.settings.active, Some(id));
    let text = std::fs::read_to_string(directory.join("connections.json")).unwrap();
    assert!(!text.contains("token"));
    std::fs::remove_dir_all(directory).unwrap();
}
#[tokio::test]
async fn gateway_has_one_use_bootstrap_cookie_and_rejects_cross_origin_requests() {
    let directory = directory("guard");
    let gateway = gateway::start(&directory, 0, Arc::new(MemoryVault::default()))
        .await
        .unwrap();
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let bootstrap = http.get(&gateway.bootstrap_url).send().await.unwrap();
    assert_eq!(bootstrap.status(), 303);
    let cookie = bootstrap
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    assert_eq!(
        http.get(&gateway.bootstrap_url)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        http.get(format!("{}/desktop/profiles", gateway.origin))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        http.post(format!("{}/desktop/remove", gateway.origin))
            .header("cookie", &cookie)
            .header("origin", "https://untrusted.invalid")
            .json(&serde_json::json!({"id":"a".repeat(64)}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let profiles = http
        .get(format!("{}/desktop/profiles", gateway.origin))
        .header("cookie", cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(profiles.status(), 200);
    gateway.stop();
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn credential_contract_supports_replacement_and_removal() {
    let vault = MemoryVault::default();
    let id = "fixture-execution";
    vault.set(id, "first fixture token").unwrap();
    vault.set(id, "second fixture token").unwrap();
    assert_eq!(
        vault.get(id).unwrap().as_deref(),
        Some("second fixture token")
    );
    vault.remove(id).unwrap();
    assert!(vault.get(id).unwrap().is_none());
}

#[tokio::test]
async fn gateway_preserves_negotiated_compression_and_the_encoded_response() {
    use axum::{response::IntoResponse, routing::get, Router};
    const GZIP: &[u8] = &[
        31, 139, 8, 0, 0, 0, 0, 0, 2, 255, 171, 86, 202, 207, 86, 178, 42, 41, 42, 77, 213, 81,
        202, 77, 45, 46, 78, 76, 79, 85, 178, 82, 74, 206, 207, 45, 40, 2, 242, 82, 83, 20, 210,
        50, 43, 74, 74, 139, 82, 149, 106, 1, 200, 191, 230, 224, 42, 0, 0, 0,
    ];
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}/", listener.local_addr().unwrap());
    let remote = tokio::spawn(async move {
        let router = Router::new().route(
            "/api/transcript",
            get(|headers: axum::http::HeaderMap| async move {
                if let Some(encoding) = headers.get("accept-encoding") {
                    assert_eq!(encoding, "gzip");
                    (
                        [
                            ("content-type", "application/json"),
                            ("content-encoding", "gzip"),
                            ("vary", "Accept-Encoding"),
                        ],
                        GZIP,
                    )
                        .into_response()
                } else {
                    axum::Json(serde_json::json!({"ok":true,"message":"compressed fixture"}))
                        .into_response()
                }
            }),
        );
        axum::serve(listener, router).await.unwrap();
    });
    let directory = directory("compression");
    Store::open(&directory)
        .unwrap()
        .save(Settings {
            active: Some("a".repeat(64)),
            profiles: vec![Profile {
                id: "a".repeat(64),
                name: "压缩回归".into(),
                mode: "direct".into(),
                address,
                remote_base: String::new(),
            }],
        })
        .unwrap();
    let gateway = gateway::start(&directory, 0, Arc::new(MemoryVault::default()))
        .await
        .unwrap();
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let bootstrap = http.get(&gateway.bootstrap_url).send().await.unwrap();
    let cookie = bootstrap.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let endpoint = format!("{}/e/{}/api/transcript", gateway.origin, "a".repeat(64));
    let compressed = http
        .get(&endpoint)
        .header("cookie", cookie)
        .header("accept-encoding", "gzip")
        .send()
        .await
        .unwrap();
    assert_eq!(compressed.status(), 200);
    assert_eq!(compressed.headers()["content-encoding"], "gzip");
    assert_eq!(compressed.headers()["vary"], "Accept-Encoding");
    assert_eq!(compressed.bytes().await.unwrap().as_ref(), GZIP);
    let plain = http
        .get(&endpoint)
        .header("cookie", cookie)
        .send()
        .await
        .unwrap();
    assert!(!plain.headers().contains_key("content-encoding"));
    assert_eq!(
        plain.json::<serde_json::Value>().await.unwrap()["message"],
        "compressed fixture"
    );
    gateway.stop();
    remote.abort();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn startup_serves_installed_pages_before_reading_only_the_requested_credential() {
    use axum::{routing::get, Json, Router};
    use std::sync::Mutex;
    struct RecordingVault(Mutex<Vec<String>>);
    impl Vault for RecordingVault {
        fn get(&self, id: &str) -> swift_desktop_core::error::Result<Option<String>> {
            self.0.lock().unwrap().push(id.to_owned());
            Ok(Some("fixture-secret".into()))
        }
        fn set(&self, _: &str, _: &str) -> swift_desktop_core::error::Result<()> {
            unreachable!()
        }
        fn remove(&self, _: &str) -> swift_desktop_core::error::Result<()> {
            unreachable!()
        }
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}/", listener.local_addr().unwrap());
    let remote = tokio::spawn(async move {
        let router = Router::new().route(
            "/api/config",
            get(|headers: axum::http::HeaderMap| async move {
                assert_eq!(headers["x-agent-studio-token"], "fixture-secret");
                Json(serde_json::json!({"ok":true,"role":"execution"}))
            }),
        );
        axum::serve(listener, router).await.unwrap();
    });
    let directory = directory("lazy-startup");
    let mut store = Store::open(&directory).unwrap();
    store
        .save(Settings {
            active: Some("a".repeat(64)),
            profiles: ['a', 'b']
                .into_iter()
                .map(|c| Profile {
                    id: c.to_string().repeat(64),
                    name: "启动验证".into(),
                    mode: "direct".into(),
                    address: address.clone(),
                    remote_base: String::new(),
                })
                .collect(),
        })
        .unwrap();
    let vault = Arc::new(RecordingVault(Mutex::new(Vec::new())));
    let gateway = gateway::start(&directory, 0, vault.clone()).await.unwrap();
    assert!(vault.0.lock().unwrap().is_empty());
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let bootstrap = http.get(&gateway.bootstrap_url).send().await.unwrap();
    let cookie = bootstrap.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    for suffix in ["/", "/style.css", "/frontend-version.json"] {
        let response = http
            .get(format!("{}/e/{}{}", gateway.origin, "a".repeat(64), suffix))
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
    }
    assert!(vault.0.lock().unwrap().is_empty());
    let stylesheet = format!(
        "{}/e/{}/style.css?v=0123456789abcdef0123",
        gateway.origin,
        "a".repeat(64)
    );
    let resource = http
        .get(&stylesheet)
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(
        resource.headers()["cache-control"],
        "private, max-age=31536000, immutable"
    );
    let etag = resource.headers()["etag"].clone();
    let cached = http
        .get(&stylesheet)
        .header("cookie", &cookie)
        .header("if-none-match", &etag)
        .send()
        .await
        .unwrap();
    assert_eq!(cached.status(), 304);
    assert!(cached.bytes().await.unwrap().is_empty());
    let document = http
        .get(format!(
            "{}/e/{}/?v=0123456789abcdef0123",
            gateway.origin,
            "a".repeat(64)
        ))
        .header("cookie", &cookie)
        .header("if-none-match", &etag)
        .send()
        .await
        .unwrap();
    assert_eq!(document.status(), 200);
    assert_eq!(document.headers()["cache-control"], "no-cache");
    assert!(!document.headers().contains_key("etag"));
    // A validator does not bypass the gateway's normal cookie check.
    assert_eq!(
        http.get(&stylesheet)
            .header("if-none-match", &etag)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let request = || {
        http.get(format!(
            "{}/e/{}/api/config",
            gateway.origin,
            "a".repeat(64)
        ))
        .header("cookie", &cookie)
        .send()
    };
    let (first, second) = tokio::join!(request(), request());
    assert_eq!(first.unwrap().status(), 200);
    assert_eq!(second.unwrap().status(), 200);
    assert_eq!(*vault.0.lock().unwrap(), vec!["a".repeat(64)]);
    gateway.stop();
    remote.abort();
    std::fs::remove_dir_all(directory).unwrap();
}
#[cfg(target_os = "windows")]
#[test]
fn windows_credential_store_retains_secrets_between_native_vault_instances() {
    use swift_desktop_core::storage::NativeVault;
    let id = format!("swift-unit-fixture-{}", std::process::id());
    NativeVault
        .set(&id, "fixture-only-not-a-live-token")
        .unwrap();
    assert_eq!(
        NativeVault.get(&id).unwrap().as_deref(),
        Some("fixture-only-not-a-live-token")
    );
    NativeVault.remove(&id).unwrap();
    assert!(NativeVault.get(&id).unwrap().is_none());
}

#[tokio::test]
async fn editing_servers_preserves_active_selection_and_endpoint_namespaces() {
    use axum::{routing::get, Json, Router};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let execution = tokio::spawn(async move {
        let config = || async { Json(serde_json::json!({"ok":true,"role":"execution"})) };
        axum::serve(
            listener,
            Router::new()
                .route("/api/config", get(config))
                .route("/second/api/config", get(config))
                .route("/third/api/config", get(config)),
        )
        .await
        .unwrap();
    });
    let directory = directory("edit");
    let gateway = gateway::start(&directory, 0, Arc::new(MemoryVault::default()))
        .await
        .unwrap();
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = http.get(&gateway.bootstrap_url).send().await.unwrap();
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let post = |route: &str, body: serde_json::Value| {
        http.post(format!("{}/desktop/{route}", gateway.origin))
            .header("cookie", &cookie)
            .header("origin", &gateway.origin)
            .json(&body)
    };
    let first: serde_json::Value = post(
        "connect",
        serde_json::json!({"mode":"direct","address":origin,"name":"first"}),
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let second: serde_json::Value = post(
        "connect",
        serde_json::json!({"mode":"direct","address":format!("{origin}/second"),"name":"second"}),
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let id = first["path"].as_str().unwrap().split('/').nth(2).unwrap();
    let second_id = second["path"].as_str().unwrap().split('/').nth(2).unwrap();
    assert_eq!(post("update", serde_json::json!({"id":id,"mode":"direct","address":format!("{origin}/second"),"name":"duplicate"}))
        .send().await.unwrap().status(), 409);
    let changed = post("update", serde_json::json!({"id":id,"mode":"direct","address":format!("{origin}/third"),"name":"renamed"}))
        .send().await.unwrap();
    assert_eq!(changed.status(), 200);
    let changed: serde_json::Value = changed.json().await.unwrap();
    let new_id = changed["profile"]["id"].as_str().unwrap();
    assert_ne!(id, new_id);
    let saved = Store::open(&directory).unwrap().settings;
    assert_eq!(saved.active.as_deref(), Some(second_id));
    assert_eq!(saved.profiles.len(), 2);
    assert!(!saved.profiles.iter().any(|profile| profile.id == id));
    assert_eq!(
        saved
            .profiles
            .iter()
            .find(|profile| profile.id == new_id)
            .unwrap()
            .name,
        "renamed"
    );
    assert_eq!(
        http.get(format!("{}/e/{id}/api/config", gateway.origin))
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    execution.abort();
    assert_eq!(post("update", serde_json::json!({"id":second_id,"mode":"direct","address":format!("{origin}/second"),"name":"offline rename"}))
        .send().await.unwrap().status(), 200);
    assert_eq!(
        Store::open(&directory).unwrap().settings.active.as_deref(),
        Some(second_id)
    );
    gateway.stop();
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn direct_links_extract_tokens_without_saving_credentials_in_the_address() {
    let (address, token) = swift_desktop_core::connection::connection_link(
        "http://192.168.1.5:8792/swift/?token=fixture-secret",
        "",
    )
    .unwrap();
    assert_eq!(address.as_str(), "http://192.168.1.5:8792/swift/");
    assert_eq!(token, "fixture-secret");
    assert!(
        swift_desktop_core::connection::connection_link("http://host/?token=first", "second")
            .is_err()
    );
    assert!(
        swift_desktop_core::connection::connection_link("http://host/?other=secret", "").is_err()
    );
    assert!(
        swift_desktop_core::connection::connection_link("http://user:pass@host/?token=x", "")
            .is_err()
    );
}
