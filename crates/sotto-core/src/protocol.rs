use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Frozen wire protocol version 1 (ADR-0025).
pub const HOST_PROTOCOL_VERSION: u8 = 1;
/// Maximum WebSocket frame size accepted by the host (32 MiB, matching `HOST_MAX_FRAME_BYTES`).
pub const HOST_MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostErrorCode {
    Unauthenticated,
    InvalidRequest,
    StaleRequest,
    Forbidden,
    Unavailable,
    Busy,
    TooLarge,
}

impl HostErrorCode {
    pub fn default_message(self) -> &'static str {
        match self {
            HostErrorCode::Unauthenticated => {
                "This connection is no longer signed in. Pair this device again to continue."
            }
            HostErrorCode::InvalidRequest => {
                "This request is not supported. Update this client and try again."
            }
            HostErrorCode::StaleRequest => {
                "This request has already changed or been answered. Refresh the thread before answering."
            }
            HostErrorCode::Forbidden => {
                "This device cannot approve that action. Answer it on the host computer."
            }
            HostErrorCode::Unavailable => {
                "The host could not complete this request. Refresh the thread before trying again."
            }
            HostErrorCode::Busy => {
                "The host has too many pending requests. Wait for them to finish and try again."
            }
            HostErrorCode::TooLarge => {
                "A thread on this host is too large to send to this device. Nothing on the host was lost, and the thread keeps working there. Your other threads still load here."
            }
        }
    }

    pub fn http_status(self) -> u16 {
        match self {
            HostErrorCode::Unauthenticated => 401,
            HostErrorCode::Forbidden => 403,
            HostErrorCode::InvalidRequest => 400,
            HostErrorCode::StaleRequest => 409,
            HostErrorCode::Busy => 429,
            HostErrorCode::TooLarge => 413,
            HostErrorCode::Unavailable => 503,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostErrorPayload {
    pub code: HostErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostDescriptor {
    pub v: u8,
    #[serde(rename = "hostId")]
    pub host_id: String,
    pub port: u16,
    pub pid: u32,
    #[serde(rename = "adminToken", skip_serializing_if = "Option::is_none")]
    pub admin_token: Option<String>,
    #[serde(rename = "startedBy", skip_serializing_if = "Option::is_none")]
    pub started_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostAbout {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub runtime: String,
    pub features: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HostRequestEnvelope {
    pub v: u8,
    pub id: String,
    pub op: String,
    #[serde(flatten)]
    pub fields: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostResponseEnvelope {
    pub v: u8,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<HostErrorPayload>,
}

impl HostResponseEnvelope {
    pub fn ok(id: String, result: Value) -> Self {
        Self {
            v: HOST_PROTOCOL_VERSION,
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: String, code: HostErrorCode, message: impl Into<String>) -> Self {
        Self {
            v: HOST_PROTOCOL_VERSION,
            id,
            ok: false,
            result: None,
            error: Some(HostErrorPayload {
                code,
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HostPushEnvelope {
    pub v: u8,
    pub push: String,
    #[serde(flatten)]
    pub fields: serde_json::Map<String, Value>,
}
