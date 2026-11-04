use crate::error::Result;
use futures_util::future::BoxFuture;
pub trait NativeUpdates: Send + Sync {
    fn check(&self) -> BoxFuture<'static, Result<serde_json::Value>>;
    fn install(&self) -> BoxFuture<'static, Result<serde_json::Value>>;
}
