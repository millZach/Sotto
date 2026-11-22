use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, watch};

use sotto_core::pairing::constant_time_eq;
use sotto_core::{
    HostAbout, HostDescriptor, HostErrorCode, HostRequestEnvelope, HostResponseEnvelope,
    MemoryStore, PairedClients, PairingError, SubagentStore, ThreadStore, UsageStore,
    HOST_PROTOCOL_VERSION,
};

use crate::ws::{
    deflate_offered, is_valid_websocket_key, read_ws_message, websocket_accept, write_ws_close,
    write_ws_pong, write_ws_text, WsMessage, WsReaderState, DEFLATE_RESPONSE,
};

const MAX_HTTP_BODY_BYTES: usize = 256 * 1024;
const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(15);
const SOTTO_HOST_VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct HostState {
    pub data_directory: PathBuf,
    pub host_id: String,
    pub port: u16,
    pub admin_token: String,
    pub started_by: Option<String>,
    pub pairing: Mutex<PairedClients>,
    pub revoked_tx: broadcast::Sender<String>,
}

impl HostState {
    pub fn descriptor(&self) -> HostDescriptor {
        HostDescriptor {
            v: HOST_PROTOCOL_VERSION,
            host_id: self.host_id.clone(),
            port: self.port,
            pid: std::process::id(),
            admin_token: Some(self.admin_token.clone()),
            started_by: self.started_by.clone(),
        }
    }

    pub fn about(&self) -> HostAbout {
        HostAbout {
            version: SOTTO_HOST_VERSION.to_string(),
            platform: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            runtime: "rust".to_string(),
            features: vec!["permessage-deflate".to_string()],
        }
    }
}

pub fn generate_admin_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn write_descriptor(directory: &Path, descriptor: &HostDescriptor) -> std::io::Result<PathBuf> {
    let path = directory.join("host-listener.json");
    let temp = directory.join(format!("host-listener.json.tmp-{}", uuid::Uuid::new_v4()));
    let body = serde_json::to_string_pretty(descriptor).map_err(std::io::Error::other)?;
    let write_res = (|| -> std::io::Result<()> {
        let mut opts = OpenOptions::new();
        opts.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&temp)?;
        file.write_all(body.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, &path)
    })();
    if write_res.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_res?;
    Ok(path)
}

pub fn cleanup_descriptor(directory: &Path, admin_token: &str) {
    let path = directory.join("host-listener.json");
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
            if parsed.get("adminToken").and_then(Value::as_str) == Some(admin_token) {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

pub struct RunningServer {
    pub state: Arc<HostState>,
    shutdown_tx: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl RunningServer {
    pub async fn start(
        data_directory: PathBuf,
        host_id: String,
        port: u16,
        started_by: Option<String>,
    ) -> std::io::Result<Self> {
        let pairing = PairedClients::load(&data_directory)
            .map_err(|err| std::io::Error::other(err.to_string()))?;
        let listener = TcpListener::bind(("127.0.0.1", port)).await?;
        let bound_port = listener.local_addr()?.port();
        let admin_token = generate_admin_token();

        let (revoked_tx, _) = broadcast::channel(64);
        let state = Arc::new(HostState {
            data_directory: data_directory.clone(),
            host_id,
            port: bound_port,
            admin_token,
            started_by,
            pairing: Mutex::new(pairing),
            revoked_tx,
        });

        write_descriptor(&data_directory, &state.descriptor())?;

        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let server_state = Arc::clone(&state);
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            break;
                        }
                    }
                    accepted = listener.accept() => {
                        if let Ok((stream, _addr)) = accepted {
                            let peer_state = Arc::clone(&server_state);
                            let peer_shutdown = shutdown_rx.clone();
                            tokio::spawn(async move {
                                let _ = handle_connection(stream, peer_state, peer_shutdown).await;
                            });
                        }
                    }
                }
            }
        });

        Ok(Self {
            state,
            shutdown_tx,
            task,
        })
    }

    pub async fn close(self) {
        let _ = self.shutdown_tx.send(true);
        let _ = self.task.await;
        cleanup_descriptor(&self.state.data_directory, &self.state.admin_token);
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairBody {
    v: u8,
    code: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientIdBody {
    #[serde(rename = "clientId")]
    client_id: String,
}

enum HeaderReadError {
    TooLarge,
    Io(std::io::Error),
}

async fn read_bounded_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    remaining: &mut usize,
) -> Result<Option<String>, HeaderReadError> {
    let mut line = Vec::new();
    loop {
        let buf = reader.fill_buf().await.map_err(HeaderReadError::Io)?;
        if buf.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(String::from_utf8_lossy(&line).into_owned()))
            };
        }
        if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let take = pos + 1;
            if take > *remaining {
                return Err(HeaderReadError::TooLarge);
            }
            line.extend_from_slice(&buf[..take]);
            reader.consume(take);
            *remaining -= take;
            return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
        }
        let len = buf.len();
        if len > *remaining {
            return Err(HeaderReadError::TooLarge);
        }
        line.extend_from_slice(buf);
        reader.consume(len);
        *remaining -= len;
    }
}

async fn handle_connection(
    stream: TcpStream,
    state: Arc<HostState>,
    shutdown: watch::Receiver<bool>,
) -> std::io::Result<()> {
    let _ = stream.set_nodelay(true);
    let mut reader = BufReader::new(stream);
    let mut remaining_header_bytes = MAX_HTTP_HEADER_BYTES;

    let read_head = tokio::time::timeout(HTTP_READ_TIMEOUT, async {
        let Some(request_line) = read_bounded_line(&mut reader, &mut remaining_header_bytes).await? else {
            return Ok::<_, HeaderReadError>(None);
        };
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("").to_string();

        let mut headers: HashMap<String, String> = HashMap::new();
        loop {
            let Some(line) = read_bounded_line(&mut reader, &mut remaining_header_bytes).await? else {
                break;
            };
            if line == "\r\n" || line == "\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
            }
            if headers.len() > 64 {
                return Err(HeaderReadError::TooLarge);
            }
        }
        Ok(Some((method, path, headers)))
    })
    .await;

    let (method, path, headers) = match read_head {
        Ok(Ok(Some(head))) => head,
        Ok(Ok(None)) | Err(_) => return Ok(()),
        Ok(Err(HeaderReadError::TooLarge)) => {
            let mut stream = reader.into_inner();
            let _ = send_http_error(&mut stream, HostErrorCode::TooLarge, None).await;
            return Ok(());
        }
        Ok(Err(HeaderReadError::Io(err))) => return Err(err),
    };

    if method == "GET"
        && path == "/v1/socket"
        && headers
            .get("upgrade")
            .map(|v| v.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
    {
        return handle_websocket_upgrade(reader.into_inner(), &headers, state, shutdown).await;
    }

    let content_length = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_HTTP_BODY_BYTES {
        let mut stream = reader.into_inner();
        send_http_error(&mut stream, HostErrorCode::TooLarge, None).await?;
        return Ok(());
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        match tokio::time::timeout(HTTP_READ_TIMEOUT, reader.read_exact(&mut body)).await {
            Ok(Ok(_)) => {}
            Ok(Err(err)) => return Err(err),
            Err(_) => return Ok(()),
        }
    }

    let mut stream = reader.into_inner();
    let bearer = extract_bearer(&headers);

    if method == "GET" && path == "/v1/health" {
        let about = state.about();
        let payload = json!({
            "v": HOST_PROTOCOL_VERSION,
            "hostId": state.host_id,
            "port": state.port,
            "pid": std::process::id(),
            "status": "ready",
            "version": about.version,
            "platform": about.platform,
            "arch": about.arch,
            "runtime": about.runtime,
            "features": about.features,
        });
        send_http_json(&mut stream, 200, &payload).await?;
        return Ok(());
    }

    if method != "POST" {
        send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
        return Ok(());
    }

    if path.starts_with("/v1/admin/") {
        if !constant_time_eq(bearer.as_bytes(), state.admin_token.as_bytes()) {
            send_http_error(&mut stream, HostErrorCode::Unauthenticated, None).await?;
            return Ok(());
        }
        if path == "/v1/admin/pairing-code" {
            let issued = state.pairing.lock().unwrap().issue_pairing_code();
            let payload = json!({
                "v": HOST_PROTOCOL_VERSION,
                "hostId": state.host_id,
                "code": issued.code,
                "expiresAt": issued.expires_at,
            });
            send_http_json(&mut stream, 200, &payload).await?;
            return Ok(());
        }
        if path == "/v1/admin/revoke-client" {
            let parsed: ClientIdBody = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(_) => {
                    send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
                    return Ok(());
                }
            };
            let revoke_result = state.pairing.lock().unwrap().revoke(&parsed.client_id);
            match revoke_result {
                Ok(revoked) => {
                    if revoked {
                        let _ = state.revoked_tx.send(parsed.client_id);
                    }
                    send_http_json(
                        &mut stream,
                        200,
                        &json!({ "v": HOST_PROTOCOL_VERSION, "hostId": state.host_id, "revoked": revoked }),
                    )
                    .await?;
                }
                Err(_) => {
                    send_http_error(&mut stream, HostErrorCode::Unavailable, None).await?;
                }
            }
            return Ok(());
        }
        send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
        return Ok(());
    }

    if path == "/v1/pair" {
        let parsed: PairBody = match serde_json::from_slice::<PairBody>(&body) {
            Ok(v) if v.v == HOST_PROTOCOL_VERSION => v,
            _ => {
                send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
                return Ok(());
            }
        };
        let result = state
            .pairing
            .lock()
            .unwrap()
            .redeem_pairing_code(&parsed.code, &parsed.name);
        match result {
            Ok(paired) => {
                send_http_json(
                    &mut stream,
                    200,
                    &json!({
                        "v": HOST_PROTOCOL_VERSION,
                        "hostId": state.host_id,
                        "clientId": paired.client_id,
                        "name": paired.name,
                        "token": paired.token,
                    }),
                )
                .await?;
            }
            Err(PairingError::CodeRejected) => {
                send_http_error(
                    &mut stream,
                    HostErrorCode::Unauthenticated,
                    Some(sotto_core::PAIRING_CODE_REJECTED),
                )
                .await?;
            }
            Err(_) => {
                send_http_error(&mut stream, HostErrorCode::Unavailable, None).await?;
            }
        }
        return Ok(());
    }

    if path == "/v1/session" {
        let client_id = state.pairing.lock().unwrap().verify_token(bearer);
        let Some(client_id) = client_id else {
            send_http_error(&mut stream, HostErrorCode::Unauthenticated, None).await?;
            return Ok(());
        };
        let issued = state.pairing.lock().unwrap().issue_session(&client_id);
        let Some(session) = issued else {
            send_http_error(&mut stream, HostErrorCode::Unauthenticated, None).await?;
            return Ok(());
        };
        send_http_json(
            &mut stream,
            200,
            &json!({
                "v": HOST_PROTOCOL_VERSION,
                "hostId": state.host_id,
                "session": session.session,
                "expiresAt": session.expires_at,
            }),
        )
        .await?;
        return Ok(());
    }

    if path == "/v1/revoke" {
        let client_id = state.pairing.lock().unwrap().verify_token(bearer);
        let Some(client_id) = client_id else {
            send_http_error(&mut stream, HostErrorCode::Unauthenticated, None).await?;
            return Ok(());
        };
        let revoke_result = state.pairing.lock().unwrap().revoke(&client_id);
        match revoke_result {
            Ok(revoked) => {
                if revoked {
                    let _ = state.revoked_tx.send(client_id);
                }
                send_http_json(
                    &mut stream,
                    200,
                    &json!({ "v": HOST_PROTOCOL_VERSION, "hostId": state.host_id, "revoked": revoked }),
                )
                .await?;
            }
            Err(_) => {
                send_http_error(&mut stream, HostErrorCode::Unavailable, None).await?;
            }
        }
        return Ok(());
    }

    send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
    Ok(())
}

async fn handle_websocket_upgrade(
    mut stream: TcpStream,
    headers: &HashMap<String, String>,
    state: Arc<HostState>,
    mut shutdown: watch::Receiver<bool>,
) -> std::io::Result<()> {
    let session = extract_bearer(headers).to_string();
    let client_id = state.pairing.lock().unwrap().verify_session(&session);
    let key = headers.get("sec-websocket-key").map(String::as_str);
    let version = headers.get("sec-websocket-version").map(String::as_str);

    let (Some(client_id), Some(key)) = (client_id, key) else {
        stream
            .write_all(b"HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            .await?;
        return Ok(());
    };
    if version != Some("13") || !is_valid_websocket_key(key) {
        stream
            .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            .await?;
        return Ok(());
    }

    let deflate = deflate_offered(headers.get("sec-websocket-extensions").map(String::as_str));
    let accept = websocket_accept(key);
    let mut response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n"
    );
    if deflate {
        response.push_str(&format!("Sec-WebSocket-Extensions: {DEFLATE_RESPONSE}\r\n"));
    }
    response.push_str("\r\n");
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;

    let mut reader_state = WsReaderState::default();
    let mut revoked_rx = state.revoked_tx.subscribe();
    let mut expiry_tick = tokio::time::interval(Duration::from_secs(1));
    expiry_tick.tick().await;

    loop {
        let next = tokio::select! {
            _ = shutdown.changed() => {
                let _ = write_ws_close(&mut stream).await;
                break;
            }
            revoked_id = revoked_rx.recv() => {
                if matches!(revoked_id, Ok(ref id) if id == &client_id)
                    || state.pairing.lock().unwrap().verify_session(&session).as_deref() != Some(client_id.as_str())
                {
                    let _ = write_ws_close(&mut stream).await;
                    break;
                }
                continue;
            }
            _ = expiry_tick.tick() => {
                if state.pairing.lock().unwrap().verify_session(&session).as_deref() != Some(client_id.as_str()) {
                    let _ = write_ws_close(&mut stream).await;
                    break;
                }
                continue;
            }
            msg = read_ws_message(&mut stream, deflate, &mut reader_state) => msg,
        };
        match next {
            Ok(WsMessage::Text(text)) => {
                // Re-verify the session before serving every request so a revoked or expired
                // device can never read another frame on an already-open socket.
                if state.pairing.lock().unwrap().verify_session(&session).as_deref()
                    != Some(client_id.as_str())
                {
                    let _ = write_ws_close(&mut stream).await;
                    break;
                }
                let reply = handle_ws_request(&state, &text);
                let encoded = serde_json::to_string(&reply).map_err(std::io::Error::other)?;
                if write_ws_text(&mut stream, &encoded, deflate).await.is_err() {
                    break;
                }
            }
            Ok(WsMessage::Ping(payload)) => {
                if write_ws_pong(&mut stream, &payload).await.is_err() {
                    break;
                }
            }
            Ok(WsMessage::Pong(_)) => {}
            Ok(WsMessage::Close) | Err(_) => {
                let _ = write_ws_close(&mut stream).await;
                break;
            }
        }
    }
    Ok(())
}

fn handle_ws_request(state: &HostState, raw: &str) -> HostResponseEnvelope {
    let req: HostRequestEnvelope = match serde_json::from_str(raw) {
        Ok(r) => r,
        Err(_) => {
            return HostResponseEnvelope::err(
                String::new(),
                HostErrorCode::InvalidRequest,
                HostErrorCode::InvalidRequest.default_message(),
            );
        }
    };
    if req.v != HOST_PROTOCOL_VERSION {
        return HostResponseEnvelope::err(
            req.id,
            HostErrorCode::InvalidRequest,
            HostErrorCode::InvalidRequest.default_message(),
        );
    }

    match req.op.as_str() {
        "hello" => {
            let about = state.about();
            let thread_ids = ThreadStore::open(&state.data_directory.join("threads.sqlite"))
                .and_then(|s| s.list_thread_ids())
                .unwrap_or_default();
            let memory_version = MemoryStore::open(&state.data_directory.join("memory.sqlite"))
                .and_then(|s| s.schema_version())
                .unwrap_or(0);
            let usage_meta = UsageStore::open(&state.data_directory.join("usage.sqlite"))
                .and_then(|s| s.read_meta())
                .ok()
                .flatten();
            let subagents_ok = SubagentStore::open(&state.data_directory.join("subagents.sqlite"))
                .and_then(|s| s.quick_check())
                .map(|s| s == "ok")
                .unwrap_or(false);
            HostResponseEnvelope::ok(
                req.id,
                json!({
                    "hostId": state.host_id,
                    "version": about.version,
                    "platform": about.platform,
                    "arch": about.arch,
                    "runtime": about.runtime,
                    "features": about.features,
                    "threadIds": thread_ids,
                    "stores": {
                        "memorySchemaVersion": memory_version,
                        "usageMeta": usage_meta,
                        "subagentsOk": subagents_ok,
                    },
                }),
            )
        }
        "ping" => HostResponseEnvelope::ok(req.id, json!({ "pong": true })),
        "shell" | "state" => {
            let thread_ids = ThreadStore::open(&state.data_directory.join("threads.sqlite"))
                .and_then(|s| s.list_thread_ids())
                .unwrap_or_default();
            HostResponseEnvelope::ok(
                req.id,
                json!({
                    "hostId": state.host_id,
                    "threadIds": thread_ids,
                }),
            )
        }
        "detail" => {
            let Some(thread_id) = req.fields.get("threadId").and_then(Value::as_str) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            match ThreadStore::open(&state.data_directory.join("threads.sqlite")) {
                Ok(store) => {
                    let messages = store.read_messages(thread_id).unwrap_or_default();
                    let activities = store.read_activities(thread_id).unwrap_or_default();
                    HostResponseEnvelope::ok(
                        req.id,
                        json!({
                            "threadId": thread_id,
                            "messages": messages,
                            "activities": activities,
                        }),
                    )
                }
                Err(_) => HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    HostErrorCode::Unavailable.default_message(),
                ),
            }
        }
        "events" => {
            let Some(thread_id) = req.fields.get("threadId").and_then(Value::as_str) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let after_seq = req
                .fields
                .get("afterSeq")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let limit = req
                .fields
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(200)
                .min(500) as usize;
            match ThreadStore::open(&state.data_directory.join("threads.sqlite")) {
                Ok(store) => {
                    let events = store
                        .read_events(thread_id, after_seq, limit)
                        .unwrap_or_default();
                    HostResponseEnvelope::ok(
                        req.id,
                        json!({
                            "threadId": thread_id,
                            "events": events,
                        }),
                    )
                }
                Err(_) => HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    HostErrorCode::Unavailable.default_message(),
                ),
            }
        }
        _ => HostResponseEnvelope::err(
            req.id,
            HostErrorCode::InvalidRequest,
            HostErrorCode::InvalidRequest.default_message(),
        ),
    }
}

fn extract_bearer(headers: &HashMap<String, String>) -> &str {
    headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer ")))
        .map(str::trim)
        .unwrap_or("")
}

async fn send_http_json(stream: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let payload = serde_json::to_vec(body).map_err(std::io::Error::other)?;
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        409 => "Conflict",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        _ => "Service Unavailable",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&payload).await?;
    stream.flush().await
}

async fn send_http_error(
    stream: &mut TcpStream,
    code: HostErrorCode,
    message: Option<&str>,
) -> std::io::Result<()> {
    let body = json!({
        "v": HOST_PROTOCOL_VERSION,
        "error": {
            "code": code,
            "message": message.unwrap_or_else(|| code.default_message()),
        }
    });
    send_http_json(stream, code.http_status(), &body).await
}
