use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub page: u32,
    pub stage: String,
    pub elapsed: u64,
    pub code: Option<u16>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub retries: Option<u32>,
    pub received: Option<u64>,
    pub network: Option<u8>,
    pub sync: Option<u8>,
    pub observer: Option<u8>,
    pub input: Option<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connection_history_is_bounded_and_rejects_content() {
        let directory =
            std::env::temp_dir().join(format!("swift-connection-trace-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let trace = Diagnostics::new(&directory);
        let event = |stage: &str| Event {
            page: 1,
            stage: stage.into(),
            elapsed: 10,
            code: Some(1006),
            line: None,
            column: None,
            retries: None,
            received: None,
            network: None,
            sync: None,
            observer: None,
            input: None,
        };
        for _ in 0..70 {
            assert!(trace.record(event("socket-close")));
        }
        assert!(!trace.record(event("arbitrary message text")));
        let records: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(&trace.file).unwrap()).unwrap();
        assert_eq!(records.len(), 64);
        assert!(serde_json::from_value::<Event>(
            serde_json::json!({"page":1,"stage":"socket-close","elapsed":0,"message":"secret"})
        )
        .is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}

pub struct Diagnostics {
    file: PathBuf,
    events: Mutex<Vec<serde_json::Value>>,
}
impl Diagnostics {
    pub fn new(directory: &std::path::Path) -> Self {
        Self {
            file: directory.join("connection-diagnostics.json"),
            events: Mutex::new(Vec::new()),
        }
    }
    pub fn snapshot(&self) -> Vec<serde_json::Value> {
        self.events
            .lock()
            .map(|events| events.clone())
            .unwrap_or_default()
    }
    pub fn record(&self, event: Event) -> bool {
        // Only lifecycle names and numeric positions/codes are accepted. No URLs,
        // credentials, session identifiers, exception messages or chat text.
        if !matches!(
            event.stage.as_str(),
            "boot-start"
                | "cache-start"
                | "cache-ready"
                | "config-start"
                | "config-ready"
                | "cache-root-start"
                | "cache-root-ready"
                | "connect-start"
                | "boot-error"
                | "socket-connecting"
                | "socket-open"
                | "socket-error"
                | "socket-close"
                | "terminal-ready"
                | "page-error"
                | "promise-error"
                | "connection-state"
                | "socket-retry"
                | "handshake-timeout"
                | "diagnostic-export"
        ) {
            return false;
        }
        if event.network.is_some_and(|v| v > 3)
            || event.sync.is_some_and(|v| v > 4)
            || event.observer.is_some_and(|v| v > 3)
            || event.input.is_some_and(|v| v > 3)
        {
            return false;
        }
        let Ok(mut events) = self.events.lock() else {
            return false;
        };
        if events.len() == 64 {
            events.remove(0);
        }
        events.push(serde_json::json!({"at":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
            "version":env!("CARGO_PKG_VERSION"),"event":event}));
        std::fs::write(&self.file, serde_json::to_vec(&*events).unwrap_or_default()).is_ok()
    }
}
