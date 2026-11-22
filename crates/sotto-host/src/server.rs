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
use tokio::sync::{broadcast, mpsc, watch};

use sotto_core::pairing::constant_time_eq;
use sotto_core::{
    DesktopClients, HostCredentials, HostDescriptor, HostErrorCode, HostRequestEnvelope,
    HostResponseEnvelope, MemoryStore, PairedClients, PairingError, SubagentStore, ThreadStore,
    UsageStore, HOST_PROTOCOL_VERSION,
};

use crate::ws::{
    deflate_offered, is_valid_websocket_key, read_ws_message, websocket_accept, write_ws_close,
    write_ws_pong, write_ws_text, WsMessage, WsReaderState, DEFLATE_RESPONSE,
};

const MAX_HTTP_BODY_BYTES: usize = 256 * 1024;
const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(15);
const REMOTE_ANSWER_GRANT_NOTE: &str =
    "The user allowed this paired device to answer permission requests on the host.";

pub const DEFAULT_SOTTO_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Base protocol v1 features advertised by this host build.
pub fn foundation_features() -> Vec<String> {
    vec![
        "client-liveness".into(),
        "answer-receipts".into(),
    ]
}

pub struct HostState {
    pub data_directory: PathBuf,
    pub host_id: String,
    pub port: u16,
    pub sotto_version: String,
    pub features: Vec<String>,
    pub admin_token: String,
    pub started_by: Option<String>,
    pub pairing: Mutex<PairedClients>,
    pub desktops: Mutex<DesktopClients>,
    pub memory: Mutex<MemoryStore>,
    pub threads: Mutex<ThreadStore>,
    pub subagents: Mutex<SubagentStore>,
    pub credentials: Mutex<HostCredentials>,
    pub revoked_tx: broadcast::Sender<String>,
}

impl HostState {
    pub fn descriptor(&self) -> HostDescriptor {
        HostDescriptor {
            v: HOST_PROTOCOL_VERSION,
            host_id: self.host_id.clone(),
            port: self.port,
            pid: std::process::id(),
            sotto_version: self.sotto_version.clone(),
            features: self.features.clone(),
            admin_token: Some(self.admin_token.clone()),
            started_by: self.started_by.clone(),
            tailnet_address: None,
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

pub struct ServerConfig {
    pub data_directory: PathBuf,
    pub host_id: String,
    pub port: u16,
    pub sotto_version: String,
    pub started_by: Option<String>,
    pub credentials: HostCredentials,
}

pub struct RunningServer {
    pub state: Arc<HostState>,
    shutdown_tx: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl RunningServer {
    pub async fn start(config: ServerConfig) -> std::io::Result<Self> {
        let pairing = PairedClients::load(&config.data_directory)
            .map_err(|err| std::io::Error::other(err.to_string()))?;
        let mut desktops = DesktopClients::new(&config.data_directory);
        desktops.refresh();
        let memory = MemoryStore::open(&config.data_directory.join("memory.sqlite"))
            .map_err(|err| std::io::Error::other(err.to_string()))?;
        let threads = ThreadStore::open(&config.data_directory.join("threads.sqlite"))
            .map_err(|err| std::io::Error::other(err.to_string()))?;
        let subagents = SubagentStore::open(&config.data_directory.join("subagents.sqlite"))
            .map_err(|err| std::io::Error::other(err.to_string()))?;

        let listener = TcpListener::bind(("127.0.0.1", config.port)).await?;
        let bound_port = listener.local_addr()?.port();
        let admin_token = generate_admin_token();
        let (revoked_tx, _) = broadcast::channel(64);

        let state = Arc::new(HostState {
            data_directory: config.data_directory.clone(),
            host_id: config.host_id,
            port: bound_port,
            sotto_version: config.sotto_version,
            features: foundation_features(),
            admin_token,
            started_by: config.started_by,
            pairing: Mutex::new(pairing),
            desktops: Mutex::new(desktops),
            memory: Mutex::new(memory),
            threads: Mutex::new(threads),
            subagents: Mutex::new(subagents),
            credentials: Mutex::new(config.credentials),
            revoked_tx,
        });

        write_descriptor(&config.data_directory, &state.descriptor())?;

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
        let Some(request_line) =
            read_bounded_line(&mut reader, &mut remaining_header_bytes).await?
        else {
            return Ok::<_, HeaderReadError>(None);
        };
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("").to_string();

        let mut headers: HashMap<String, String> = HashMap::new();
        loop {
            let Some(line) = read_bounded_line(&mut reader, &mut remaining_header_bytes).await?
            else {
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
        let payload = state.descriptor().public_health();
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
                    state.desktops.lock().unwrap().remove(&parsed.client_id);
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
        if path == "/v1/admin/allow-answers" || path == "/v1/admin/deny-answers" {
            let parsed: ClientIdBody = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(_) => {
                    send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
                    return Ok(());
                }
            };
            let is_paired = state.pairing.lock().unwrap().is_paired(&parsed.client_id);
            if !is_paired {
                send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
                return Ok(());
            }
            let allowed = path.ends_with("/allow-answers");
            let write_res = state.memory.lock().unwrap().set_remote_answers(
                &parsed.client_id,
                allowed,
                REMOTE_ANSWER_GRANT_NOTE,
            );
            match write_res {
                Ok(()) => {
                    send_http_json(
                        &mut stream,
                        200,
                        &json!({ "v": HOST_PROTOCOL_VERSION, "hostId": state.host_id, "ok": true }),
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
                // Exact protocol v1 `/v1/pair` response shape (matching `socketServer.ts`).
                send_http_json(
                    &mut stream,
                    200,
                    &json!({
                        "v": HOST_PROTOCOL_VERSION,
                        "hostId": state.host_id,
                        "clientId": paired.client_id,
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
                "clientId": client_id,
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
                state.desktops.lock().unwrap().remove(&client_id);
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

enum OutboundFrame {
    Text(String),
    Pong(Vec<u8>),
    Close,
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

    // Full-duplex split so server-initiated pushes can be sent concurrently with reads.
    let (mut read_half, mut write_half) = tokio::io::split(stream);
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<OutboundFrame>();

    let writer_task = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            let res = match frame {
                OutboundFrame::Text(text) => write_ws_text(&mut write_half, &text, deflate).await,
                OutboundFrame::Pong(payload) => write_ws_pong(&mut write_half, &payload).await,
                OutboundFrame::Close => {
                    let _ = write_ws_close(&mut write_half).await;
                    break;
                }
            };
            if res.is_err() {
                break;
            }
        }
    });

    let mut reader_state = WsReaderState::default();
    let mut revoked_rx = state.revoked_tx.subscribe();
    let mut expiry_tick = tokio::time::interval(Duration::from_secs(1));
    expiry_tick.tick().await;

    loop {
        let next = tokio::select! {
            _ = shutdown.changed() => {
                let _ = out_tx.send(OutboundFrame::Close);
                break;
            }
            revoked_id = revoked_rx.recv() => {
                if matches!(revoked_id, Ok(ref id) if id == &client_id)
                    || state.pairing.lock().unwrap().verify_session(&session).as_deref() != Some(client_id.as_str())
                {
                    let _ = out_tx.send(OutboundFrame::Close);
                    break;
                }
                continue;
            }
            _ = expiry_tick.tick() => {
                if state.pairing.lock().unwrap().verify_session(&session).as_deref() != Some(client_id.as_str()) {
                    let _ = out_tx.send(OutboundFrame::Close);
                    break;
                }
                continue;
            }
            msg = read_ws_message(&mut read_half, deflate, &mut reader_state) => msg,
        };
        match next {
            Ok(WsMessage::Text(text)) => {
                // Re-verify the session before serving every request so a revoked or expired
                // device can never read another frame on an already-open socket.
                if state.pairing.lock().unwrap().verify_session(&session).as_deref()
                    != Some(client_id.as_str())
                {
                    let _ = out_tx.send(OutboundFrame::Close);
                    break;
                }
                let reply = handle_ws_request(&state, &client_id, &session, &text);
                let encoded = serde_json::to_string(&reply).map_err(std::io::Error::other)?;
                if out_tx.send(OutboundFrame::Text(encoded)).is_err() {
                    break;
                }
            }
            Ok(WsMessage::Ping(payload)) => {
                if out_tx.send(OutboundFrame::Pong(payload)).is_err() {
                    break;
                }
            }
            Ok(WsMessage::Pong(_)) => {}
            Ok(WsMessage::Close) | Err(_) => {
                let _ = out_tx.send(OutboundFrame::Close);
                break;
            }
        }
    }

    drop(out_tx);
    let _ = writer_task.await;
    Ok(())
}

fn handle_ws_request(
    state: &HostState,
    client_id: &str,
    upgrade_session: &str,
    raw: &str,
) -> HostResponseEnvelope {
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
    if let Some(ref msg_session) = req.session {
        if !constant_time_eq(msg_session.as_bytes(), upgrade_session.as_bytes())
            && state.pairing.lock().unwrap().verify_session(msg_session).as_deref()
                != Some(client_id)
        {
            return HostResponseEnvelope::err(
                req.id,
                HostErrorCode::Unauthenticated,
                HostErrorCode::Unauthenticated.default_message(),
            );
        }
    }

    match req.op.as_str() {
        "hello" => {
            let after_seq = req
                .fields
                .get("afterSeq")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let may_answer = state
                .memory
                .lock()
                .unwrap()
                .may_grant_remote(client_id)
                .unwrap_or(false);
            let (thread_ids, latest_seq, events, has_more) = {
                let store = state.threads.lock().unwrap();
                let ids = store.list_thread_ids().unwrap_or_default();
                let latest = store.latest_seq().unwrap_or(0);
                let (ev, more) = store.read_events(None, after_seq, 200).unwrap_or_default();
                (ids, latest, ev, more)
            };
            let memory_version = state
                .memory
                .lock()
                .unwrap()
                .schema_version()
                .unwrap_or(0);
            let subagents_ok = state
                .subagents
                .lock()
                .unwrap()
                .quick_check()
                .map(|s| s == "ok")
                .unwrap_or(false);
            let usage_meta = UsageStore::open(&state.data_directory.join("usage.sqlite"))
                .and_then(|s| s.read_meta())
                .ok()
                .flatten();
            let credentials_secure = state.credentials.lock().unwrap().is_secure();

            HostResponseEnvelope::ok(
                req.id,
                json!({
                    "hostId": state.host_id,
                    "clientId": client_id,
                    "sottoVersion": state.sotto_version,
                    "features": state.features,
                    "capabilities": { "mayAnswer": may_answer },
                    "events": events,
                    "hasMore": has_more,
                    "latestSeq": latest_seq.max(after_seq),
                    "phoneAccess": { "phones": 0, "status": "off" },
                    "threadIds": thread_ids,
                    "stores": {
                        "memorySchemaVersion": memory_version,
                        "usageMeta": usage_meta,
                        "subagentsOk": subagents_ok,
                        "credentialsSecure": credentials_secure,
                    },
                }),
            )
        }
        "ping" => HostResponseEnvelope::ok(req.id, json!({ "pong": true })),
        "shell" | "state" => {
            let thread_ids = state
                .threads
                .lock()
                .unwrap()
                .list_thread_ids()
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
            let store = state.threads.lock().unwrap();
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
        "events" => {
            let thread_id = req.fields.get("threadId").and_then(Value::as_str);
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
            let store = state.threads.lock().unwrap();
            let latest_seq = store.latest_seq().unwrap_or(0);
            let (events, has_more) = store
                .read_events(thread_id, after_seq, limit)
                .unwrap_or_default();
            HostResponseEnvelope::ok(
                req.id,
                json!({
                    "events": events,
                    "hasMore": has_more,
                    "latestSeq": latest_seq,
                }),
            )
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
        .and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
        })
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
