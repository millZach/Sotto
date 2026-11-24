// Phase 2 reverse-RPC shell bridge surface (ADR-0210); subsequent Phase 4b slices wire the
// remaining desktop services (Checkpoints, PhoneAccess, Plugins, Council, Hosts, Watcher) onto it.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::transport::{box_binary, unbox_binary, EngineDuplex, SerializedEngineError};

const SHELL_RPC_TIMEOUT: Duration = Duration::from_secs(15);

/// Mirror of Electron's `CredentialSnapshot` (`src/main/agents/credentials.ts`, ADR-0210).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CredentialSnapshot {
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub plaintext: HashMap<String, String>,
    #[serde(default)]
    pub sealed: HashMap<String, String>,
    #[serde(default)]
    pub unreadable: HashMap<String, String>,
}

/// Mirror of `EngineWindowFocus` (`src/main/engine/types.ts`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineWindowFocus {
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub showing: bool,
    #[serde(default)]
    pub blurred_at: u64,
}

/// In-memory mirror of OS-encrypted credentials held by Electron's `safeStorage` broker (ADR-0210).
/// Matches `RemoteCredentialsCache` in `src/main/engine/engineProcess.ts`.
#[derive(Clone)]
pub struct RemoteCredentialsCache {
    snapshot: Arc<RwLock<CredentialSnapshot>>,
    duplex: EngineDuplex,
}

impl RemoteCredentialsCache {
    pub fn new(initial: CredentialSnapshot, duplex: EngineDuplex) -> Self {
        Self {
            snapshot: Arc::new(RwLock::new(initial)),
            duplex,
        }
    }

    pub fn apply_snapshot(&self, next: CredentialSnapshot) {
        let mut guard = self.snapshot.write().unwrap_or_else(|e| e.into_inner());
        *guard = next;
    }

    pub fn available(&self) -> bool {
        self.snapshot
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .available
    }

    pub fn has(&self, slot: &str) -> bool {
        self.snapshot
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .sealed
            .get(slot)
            .is_some_and(|v| !v.is_empty())
    }

    pub fn get(&self, slot: &str) -> Result<String, String> {
        let guard = self.snapshot.read().unwrap_or_else(|e| e.into_inner());
        if !guard.sealed.get(slot).is_some_and(|v| !v.is_empty()) {
            return Ok(String::new());
        }
        if !guard.available {
            return Err("Unlock your operating system credential store to continue.".into());
        }
        if let Some(reason) = guard.unreadable.get(slot) {
            return Err(reason.clone());
        }
        Ok(guard.plaintext.get(slot).cloned().unwrap_or_default())
    }

    pub fn sealed(&self, slot: &str) -> Option<String> {
        self.snapshot
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .sealed
            .get(slot)
            .filter(|v| !v.is_empty())
            .cloned()
    }

    pub async fn set(&self, slot: &str, value: &str) -> Result<(), SerializedEngineError> {
        let raw = self
            .duplex
            .request(
                "shell:credentialsSet",
                vec![json!(slot), json!(value)],
                SHELL_RPC_TIMEOUT,
            )
            .await?;
        let updated: CredentialSnapshot = serde_json::from_value(raw).map_err(|_| {
            SerializedEngineError::new("Invalid credential snapshot from shell.", Some("SHELL_ERROR"))
        })?;
        self.apply_snapshot(updated);
        Ok(())
    }

    pub async fn restore_sealed(
        &self,
        slot: &str,
        sealed: Option<&str>,
    ) -> Result<(), SerializedEngineError> {
        let raw = self
            .duplex
            .request(
                "shell:credentialsRestoreSealed",
                vec![json!(slot), sealed.map(|s| json!(s)).unwrap_or(Value::Null)],
                SHELL_RPC_TIMEOUT,
            )
            .await?;
        let updated: CredentialSnapshot = serde_json::from_value(raw).map_err(|_| {
            SerializedEngineError::new("Invalid credential snapshot from shell.", Some("SHELL_ERROR"))
        })?;
        self.apply_snapshot(updated);
        Ok(())
    }
}

/// Strongly-typed Phase 2 reverse-RPC proxy from `sotto-engine` back to Electron main (ADR-0210).
/// Mirrors `EngineShellBridge` in `src/main/engine/types.ts` and `src/main/engine/engineProcess.ts`.
#[derive(Clone)]
pub struct ShellBridgeClient {
    duplex: EngineDuplex,
    credentials: RemoteCredentialsCache,
    downloads_folder: Arc<RwLock<String>>,
    window_focus: Arc<RwLock<EngineWindowFocus>>,
    has_notify: Arc<RwLock<bool>>,
    has_media_thumbnail: Arc<RwLock<bool>>,
    has_redraw_photo: Arc<RwLock<bool>>,
}

impl ShellBridgeClient {
    pub fn new(duplex: EngineDuplex) -> Self {
        let credentials = RemoteCredentialsCache::new(CredentialSnapshot::default(), duplex.clone());
        Self {
            duplex,
            credentials,
            downloads_folder: Arc::new(RwLock::new(String::new())),
            window_focus: Arc::new(RwLock::new(EngineWindowFocus::default())),
            has_notify: Arc::new(RwLock::new(false)),
            has_media_thumbnail: Arc::new(RwLock::new(false)),
            has_redraw_photo: Arc::new(RwLock::new(false)),
        }
    }

    /// Initializes the bridge from a Phase 2 `engine:init` payload.
    pub fn apply_init(&self, payload: &Value) {
        if let Some(creds_val) = payload.get("credentials") {
            if let Ok(snap) = serde_json::from_value::<CredentialSnapshot>(creds_val.clone()) {
                self.credentials.apply_snapshot(snap);
            }
        }
        if let Some(downloads) = payload.get("downloadsFolder").and_then(Value::as_str) {
            *self
                .downloads_folder
                .write()
                .unwrap_or_else(|e| e.into_inner()) = downloads.to_string();
        }
        if let Some(flag) = payload.get("hasNotify").and_then(Value::as_bool) {
            *self.has_notify.write().unwrap_or_else(|e| e.into_inner()) = flag;
        }
        if let Some(flag) = payload.get("hasMediaThumbnail").and_then(Value::as_bool) {
            *self
                .has_media_thumbnail
                .write()
                .unwrap_or_else(|e| e.into_inner()) = flag;
        }
        if let Some(flag) = payload.get("hasRedrawPhoto").and_then(Value::as_bool) {
            *self
                .has_redraw_photo
                .write()
                .unwrap_or_else(|e| e.into_inner()) = flag;
        }
    }

    pub fn credentials(&self) -> &RemoteCredentialsCache {
        &self.credentials
    }

    pub fn downloads_folder(&self) -> String {
        self.downloads_folder
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn set_window_focus(&self, focus: EngineWindowFocus) {
        *self.window_focus.write().unwrap_or_else(|e| e.into_inner()) = focus;
    }

    pub fn window_focus(&self) -> EngineWindowFocus {
        self.window_focus
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    // One-way push verbs (Engine → Shell)
    pub fn send_to_main(&self, channel: &str, payload: Value) -> bool {
        self.duplex
            .send_push("shell:sendToMain", json!({ "channel": channel, "payload": payload }))
    }

    pub fn send_to_popup(&self, channel: &str, payload: Value) -> bool {
        self.duplex
            .send_push("shell:sendToPopup", json!({ "channel": channel, "payload": payload }))
    }

    pub fn files_bindings_delta(&self, delta: Value) -> bool {
        self.duplex.send_push("shell:filesBindingsDelta", delta)
    }

    pub fn restart_hold_changed(&self, reason: Option<&str>) -> bool {
        self.duplex.send_push(
            "shell:restartHoldChanged",
            reason.map(|r| json!(r)).unwrap_or(Value::Null),
        )
    }

    pub fn notify(&self, alert: Value) -> bool {
        if !*self.has_notify.read().unwrap_or_else(|e| e.into_inner()) {
            return false;
        }
        self.duplex.send_push("shell:notify", alert)
    }

    pub fn publish_recovery_notice(&self, notice: Value) -> bool {
        self.duplex.send_push("shell:publishRecoveryNotice", notice)
    }

    pub fn reveal_in_folder(&self, path: &str) -> bool {
        self.duplex.send_push("shell:revealInFolder", json!(path))
    }

    pub fn relaunch_app(&self) -> bool {
        self.duplex.send_push("shell:relaunchApp", Value::Null)
    }

    pub fn log(&self, code: &str) -> bool {
        self.duplex.send_push("shell:log", json!(code))
    }

    // Reverse-RPC verbs (Engine → Shell)
    pub async fn open_external(&self, url: &str) -> Result<(), SerializedEngineError> {
        let _ = self
            .duplex
            .request("shell:openExternal", vec![json!(url)], SHELL_RPC_TIMEOUT)
            .await?;
        Ok(())
    }

    pub async fn open_path(&self, path: &str) -> Result<String, SerializedEngineError> {
        let val = self
            .duplex
            .request("shell:openPath", vec![json!(path)], SHELL_RPC_TIMEOUT)
            .await?;
        Ok(val.as_str().unwrap_or("").to_string())
    }

    pub async fn clipboard_write(&self, text: &str) -> Result<(), SerializedEngineError> {
        let _ = self
            .duplex
            .request("shell:clipboardWrite", vec![json!(text)], SHELL_RPC_TIMEOUT)
            .await?;
        Ok(())
    }

    pub async fn end_host_terminals(&self, host_id: &str) -> Result<(), SerializedEngineError> {
        let _ = self
            .duplex
            .request(
                "shell:endHostTerminals",
                vec![json!(host_id)],
                SHELL_RPC_TIMEOUT,
            )
            .await?;
        Ok(())
    }

    pub async fn read_writing_settings(&self) -> Result<Value, SerializedEngineError> {
        self.duplex
            .request("shell:readWritingSettings", vec![], SHELL_RPC_TIMEOUT)
            .await
    }

    pub async fn browser_call(
        &self,
        thread_id: &str,
        name: &str,
        tool_args: Value,
        context: Option<Value>,
    ) -> Result<Value, SerializedEngineError> {
        self.duplex
            .request(
                "shell:browserCall",
                vec![
                    json!(thread_id),
                    json!(name),
                    tool_args,
                    context.unwrap_or(Value::Null),
                ],
                Duration::from_secs(60),
            )
            .await
    }

    pub async fn browser_mcp_server(&self, thread_id: &str) -> Result<Value, SerializedEngineError> {
        self.duplex
            .request(
                "shell:browserMcpServer",
                vec![json!(thread_id)],
                SHELL_RPC_TIMEOUT,
            )
            .await
    }

    pub async fn media_thumbnail(
        &self,
        data_url: &str,
        scale: f64,
    ) -> Result<Option<String>, SerializedEngineError> {
        if !*self
            .has_media_thumbnail
            .read()
            .unwrap_or_else(|e| e.into_inner())
        {
            return Ok(None);
        }
        let val = self
            .duplex
            .request(
                "shell:mediaThumbnail",
                vec![json!(data_url), json!(scale)],
                SHELL_RPC_TIMEOUT,
            )
            .await?;
        Ok(val.as_str().map(ToString::to_string))
    }

    pub async fn redraw_photo(
        &self,
        bytes: &[u8],
        kind: &str,
    ) -> Result<Option<(Vec<u8>, String)>, SerializedEngineError> {
        if !*self
            .has_redraw_photo
            .read()
            .unwrap_or_else(|e| e.into_inner())
        {
            return Ok(None);
        }
        let val = self
            .duplex
            .request(
                "shell:redrawPhoto",
                vec![box_binary(bytes), json!(kind)],
                SHELL_RPC_TIMEOUT,
            )
            .await?;
        if val.is_null() {
            return Ok(None);
        }
        let out_bytes = val.get("bytes").and_then(unbox_binary).ok_or_else(|| {
            SerializedEngineError::new("Shell redrawPhoto missing boxed bytes.", Some("SHELL_ERROR"))
        })?;
        let out_kind = val
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or(kind)
            .to_string();
        Ok(Some((out_bytes, out_kind)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::{ok_response_frame, read_engine_frame, write_engine_frame, IncomingEngineMessage};

    #[tokio::test]
    async fn credentials_cache_enforces_lock_unreadable_and_syncs_via_reverse_rpc() {
        let (engine_side, shell_side) = tokio::io::duplex(32 * 1024);
        let (mut shell_read, mut shell_write) = tokio::io::split(shell_side);
        let parts = EngineDuplex::connect_stream(engine_side, None).await.unwrap();

        let bridge = ShellBridgeClient::new(parts.duplex.clone());
        bridge.apply_init(&json!({
            "downloadsFolder": "/tmp/downloads",
            "hasNotify": true,
            "hasRedrawPhoto": true,
            "credentials": {
                "available": false,
                "plaintext": {},
                "sealed": { "formatting": "enc-1" },
                "unreadable": {}
            }
        }));
        assert_eq!(bridge.downloads_folder(), "/tmp/downloads");
        assert!(bridge.credentials().has("formatting"));
        assert!(!bridge.credentials().available());
        assert!(bridge.credentials().get("formatting").is_err());
        assert_eq!(bridge.credentials().get("missing").unwrap(), "");

        // Unlock and update via reverse-RPC `shell:credentialsSet`.
        let creds = bridge.credentials().clone();
        let set_task = tokio::spawn(async move { creds.set("plugin:abc", "tok-123").await });

        let req = read_engine_frame(&mut shell_read).await.unwrap().unwrap();
        let req_id = match req {
            IncomingEngineMessage::Req { id, method, args } => {
                assert_eq!(method, "shell:credentialsSet");
                assert_eq!(args[0], "plugin:abc");
                assert_eq!(args[1], "tok-123");
                id
            }
            other => panic!("expected req, got {other:?}"),
        };
        write_engine_frame(
            &mut shell_write,
            &ok_response_frame(
                req_id,
                json!({
                    "available": true,
                    "plaintext": { "plugin:abc": "tok-123" },
                    "sealed": { "plugin:abc": "enc-2" },
                    "unreadable": { "broken": "OS keyring denied" }
                }),
            ),
        )
        .await
        .unwrap();

        set_task.await.unwrap().unwrap();
        assert!(bridge.credentials().available());
        assert_eq!(bridge.credentials().get("plugin:abc").unwrap(), "tok-123");
        assert_eq!(
            bridge.credentials().sealed("plugin:abc").as_deref(),
            Some("enc-2")
        );

        parts.reader_task.abort();
        parts.writer_task.abort();
    }
}
