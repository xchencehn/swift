use futures_util::future::BoxFuture;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use swift_desktop_core::{
    error::{ClientError, Result},
    updates::NativeUpdates,
};
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct Updates {
    app: tauri::AppHandle,
    pending: Arc<Mutex<Option<Update>>>,
}
impl Updates {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            pending: Arc::new(Mutex::new(None)),
        }
    }
}
fn failed() -> ClientError {
    ClientError(
        reqwest::StatusCode::BAD_GATEWAY,
        "UPDATE_FAILED",
        "无法获取或验证更新，请稍后重试。",
    )
}
impl NativeUpdates for Updates {
    fn check(&self) -> BoxFuture<'static, Result<serde_json::Value>> {
        let app = self.app.clone();
        let pending = self.pending.clone();
        Box::pin(async move {
            let certificate = reqwest::Certificate::from_pem(include_bytes!(
                "../../../deploy/windows/update-root.crt"
            ))
            .map_err(|_| failed())?;
            let updater = app
                .updater_builder()
                .timeout(Duration::from_secs(30))
                .no_proxy()
                .configure_client(move |client| {
                    client
                        .add_root_certificate(certificate.clone())
                        .redirect(reqwest::redirect::Policy::none())
                })
                .build()
                .map_err(|_| failed())?;
            let update = updater.check().await.map_err(|_| failed())?;
            if let Some(update) = &update {
                let url = &update.download_url;
                if url.scheme() != "https"
                    || url.host_str() != Some("150.158.39.216")
                    || url.port_or_known_default() != Some(8002)
                    || !url.path().starts_with("/desktop/")
                {
                    return Err(failed());
                }
            }
            let result = if let Some(update) = &update {
                serde_json::json!({"available":true,"version":update.version})
            } else {
                serde_json::json!({"available":false})
            };
            *pending.lock().map_err(|_| failed())? = update;
            Ok(result)
        })
    }
    fn install(&self) -> BoxFuture<'static, Result<serde_json::Value>> {
        let update = self.pending.lock().ok().and_then(|mut value| value.take());
        Box::pin(async move {
            let update = update.ok_or_else(failed)?;
            // The official updater verifies the embedded public-key signature before launching NSIS.
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|_| failed())?;
            Ok(serde_json::json!({"ok":true}))
        })
    }
}
