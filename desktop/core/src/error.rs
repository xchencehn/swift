use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, Clone)]
pub struct ClientError(pub StatusCode, pub &'static str, pub &'static str);
pub type Result<T> = std::result::Result<T, ClientError>;
impl ClientError {
    pub fn invalid() -> Self {
        Self(
            StatusCode::BAD_REQUEST,
            "INVALID_CONNECTION",
            "连接信息无效，请检查地址和 token。",
        )
    }
    pub fn network() -> Self {
        Self(
            StatusCode::BAD_GATEWAY,
            "NETWORK_UNAVAILABLE",
            "无法连接执行端，请检查地址和网络。",
        )
    }
    pub fn unauthorized() -> Self {
        Self(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Token 不正确或已失效，请重新填写。",
        )
    }
    pub fn storage() -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "STORAGE_UNAVAILABLE",
            "无法保存连接，请检查系统凭据库和应用目录。",
        )
    }
    pub fn offline() -> Self {
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            "EXECUTION_OFFLINE",
            "执行端尚未上线，请稍后重试。",
        )
    }
}
impl IntoResponse for ClientError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(json!({"ok":false,"code":self.1,"message":self.2})),
        )
            .into_response()
    }
}
impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.2)
    }
}
impl std::error::Error for ClientError {}
