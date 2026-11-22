use std::collections::{BTreeMap, HashMap};
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
use tokio::sync::{broadcast, mpsc, watch, Semaphore};

use sotto_core::pairing::constant_time_eq;
use sotto_core::{
    ClientContext, CoordinatorBroadcast, CoordinatorHandle, DesktopClients, HostCredentials,
    HostDescriptor, HostErrorCode, HostRequestEnvelope, HostResponseEnvelope, MemoryStore,
    PairedClients, PairingError, ProviderAdapter, SubagentStore, HOST_PROTOCOL_VERSION,
};

use crate::wire_codec::ClientWireState;
use crate::ws::{
    deflate_offered, is_valid_websocket_key, read_ws_message, websocket_accept, write_ws_close,
    write_ws_pong, write_ws_text, WsMessage, WsReaderState, DEFLATE_RESPONSE,
};

const MAX_HTTP_BODY_BYTES: usize = 256 * 1024;
const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CONCURRENT_CONNECTIONS: usize = 64;
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(50);
const REMOTE_ANSWER_GRANT_NOTE: &str =
    "The user allowed this paired device to answer permission requests on the host.";

pub const DEFAULT_SOTTO_VERSION: &str = match option_env!("SOTTO_HOST_VERSION") {
    Some(v) if !v.is_empty() => v,
    _ => env!("CARGO_PKG_VERSION"),
};

/// Protocol v1 features advertised by this host build.
pub fn advertised_features() -> Vec<String> {
    vec![
        "client-liveness".into(),
        "message-aliases".into(),
        "detail-delta".into(),
        "attachment-staging".into(),
        "file-staging".into(),
        "activity-summaries".into(),
        "model-catalog-revision".into(),
        "answer-receipts".into(),
        "changed-thread-records".into(),
        "reply-thread-records".into(),
        "command-changed-thread-records".into(),
        "kept-parts".into(),
        "detail-read-held".into(),
        "provider-opencode".into(),
        "provider-cursor".into(),
        "provider-deepseek".into(),
        "provider-hermes".into(),
        "provider-antigravity".into(),
        "git-refs".into(),
        "git-changed-files".into(),
        "host-folders".into(),
        "thread-files".into(),
        "thread-changes".into(),
        "host-facts".into(),
        "thread-words".into(),
        "subagents".into(),
        "usage-dashboard".into(),
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
    pub subagents: Mutex<SubagentStore>,
    pub credentials: Mutex<HostCredentials>,
    pub coordinator: CoordinatorHandle,
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
    pub providers: BTreeMap<String, Arc<dyn ProviderAdapter>>,
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
        let subagents = SubagentStore::open(&config.data_directory.join("subagents.sqlite"))
            .map_err(|err| std::io::Error::other(err.to_string()))?;
        let credentials_secure = config.credentials.is_secure();
        let coordinator = CoordinatorHandle::spawn(
            config.data_directory.clone(),
            config.host_id.clone(),
            credentials_secure,
            config.providers,
        )
        .map_err(std::io::Error::other)?;

        let listener = TcpListener::bind(("127.0.0.1", config.port)).await?;
        let bound_port = listener.local_addr()?.port();
        let admin_token = generate_admin_token();
        let (revoked_tx, _) = broadcast::channel(64);

        let state = Arc::new(HostState {
            data_directory: config.data_directory.clone(),
            host_id: config.host_id,
            port: bound_port,
            sotto_version: config.sotto_version,
            features: advertised_features(),
            admin_token,
            started_by: config.started_by,
            pairing: Mutex::new(pairing),
            desktops: Mutex::new(desktops),
            memory: Mutex::new(memory),
            subagents: Mutex::new(subagents),
            credentials: Mutex::new(config.credentials),
            coordinator,
            revoked_tx,
        });

        write_descriptor(&config.data_directory, &state.descriptor())?;

        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let server_state = Arc::clone(&state);
        let conn_limit = Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTIONS));
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            break;
                        }
                    }
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((stream, _addr)) => {
                                let Ok(permit) = Arc::clone(&conn_limit).try_acquire_owned() else {
                                    drop(stream);
                                    continue;
                                };
                                let peer_state = Arc::clone(&server_state);
                                let peer_shutdown = shutdown_rx.clone();
                                tokio::spawn(async move {
                                    let _permit = permit;
                                    let _ = handle_connection(stream, peer_state, peer_shutdown).await;
                                });
                            }
                            Err(_) => {
                                tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                            }
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
        self.state.coordinator.shutdown().await;
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

    if !is_allowed_origin(headers.get("origin").map(String::as_str)) {
        let mut stream = reader.into_inner();
        send_http_error(&mut stream, HostErrorCode::Forbidden, None).await?;
        return Ok(());
    }

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
    let auth = {
        let mut pairing = state.pairing.lock().unwrap();
        pairing
            .verify_session_with_expiry(&session)
            .map(|(cid, expiry_ms)| {
                let name = pairing
                    .list()
                    .iter()
                    .find(|c| c.client_id == cid)
                    .map(|c| c.name.clone())
                    .unwrap_or_else(|| "Paired client".into());
                (cid, name, expiry_ms)
            })
    };
    let Some((client_id, client_name, expiry_ms)) = auth else {
        stream
            .write_all(
                b"HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            )
            .await?;
        return Ok(());
    };
    let key = headers.get("sec-websocket-key").map(String::as_str);
    let version = headers.get("sec-websocket-version").map(String::as_str);

    let Some(key) = key else {
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

    let (mut read_half, mut write_half) = tokio::io::split(stream);
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<OutboundFrame>();
    let (in_tx, mut in_rx) = mpsc::channel(64);

    // Dedicated cancel-safe reader task: `read_ws_message` is never cancelled mid-frame by
    // coordinator broadcasts, revocations, or timers.
    let reader_task = tokio::spawn(async move {
        let mut reader_state = WsReaderState::default();
        loop {
            let res = read_ws_message(&mut read_half, deflate, &mut reader_state).await;
            let done = matches!(&res, Ok(WsMessage::Close) | Err(_));
            if in_tx.send(res).await.is_err() || done {
                break;
            }
        }
    });

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

    let mut wire = ClientWireState::default();
    let mut revoked_rx = state.revoked_tx.subscribe();
    let mut coord_rx = state.coordinator.subscribe();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let remaining_ms = (expiry_ms - now_ms).max(0) as u64;
    let expiry_sleep = tokio::time::sleep(Duration::from_millis(remaining_ms));
    tokio::pin!(expiry_sleep);

    loop {
        tokio::select! {
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
            }
            _ = &mut expiry_sleep => {
                let _ = out_tx.send(OutboundFrame::Close);
                break;
            }
            bcast = coord_rx.recv() => {
                if !wire.hello_done {
                    continue;
                }
                match bcast {
                    Ok(CoordinatorBroadcast::Shell(mut shell)) => {
                        let may_answer = state
                            .memory
                            .lock()
                            .unwrap()
                            .may_grant_remote(&client_id)
                            .unwrap_or(false);
                        if let Some(obj) = shell.as_object_mut() {
                            obj.insert(
                                "clientCapabilities".into(),
                                json!({ "mayAnswer": may_answer }),
                            );
                        }
                        let frame = wire.encode_shell_push(shell);
                        if let Ok(encoded) = serde_json::to_string(&frame) {
                            if out_tx.send(OutboundFrame::Text(encoded)).is_err() {
                                break;
                            }
                        }
                    }
                    Ok(CoordinatorBroadcast::Detail(detail)) => {
                        if let Some(frame) = wire.encode_detail_update_push(&detail) {
                            if let Ok(encoded) = serde_json::to_string(&frame) {
                                if out_tx.send(OutboundFrame::Text(encoded)).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // On lag, resend whole shell cleanly so the client stays in sync.
                        let may_answer = state
                            .memory
                            .lock()
                            .unwrap()
                            .may_grant_remote(&client_id)
                            .unwrap_or(false);
                        if let Ok(shell) = state.coordinator.shell(may_answer).await {
                            let frame = wire.encode_shell_push(shell);
                            if let Ok(encoded) = serde_json::to_string(&frame) {
                                let _ = out_tx.send(OutboundFrame::Text(encoded));
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            maybe_msg = in_rx.recv() => {
                let Some(msg) = maybe_msg else {
                    let _ = out_tx.send(OutboundFrame::Close);
                    break;
                };
                match msg {
                    Ok(WsMessage::Text(text)) => {
                        if state.pairing.lock().unwrap().verify_session(&session).as_deref()
                            != Some(client_id.as_str())
                        {
                            let _ = out_tx.send(OutboundFrame::Close);
                            break;
                        }
                        let reply = handle_ws_request(
                            &state,
                            &client_id,
                            &client_name,
                            &session,
                            &mut wire,
                            &out_tx,
                            &text,
                        )
                        .await;
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
        }
    }

    reader_task.abort();
    drop(out_tx);
    let _ = writer_task.await;
    Ok(())
}

async fn handle_ws_request(
    state: &HostState,
    client_id: &str,
    client_name: &str,
    upgrade_session: &str,
    wire: &mut ClientWireState,
    out_tx: &mpsc::UnboundedSender<OutboundFrame>,
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
            && state
                .pairing
                .lock()
                .unwrap()
                .verify_session(msg_session)
                .as_deref()
                != Some(client_id)
        {
            return HostResponseEnvelope::err(
                req.id,
                HostErrorCode::Unauthenticated,
                HostErrorCode::Unauthenticated.default_message(),
            );
        }
    }

    let may_answer = state
        .memory
        .lock()
        .unwrap()
        .may_grant_remote(client_id)
        .unwrap_or(false);

    match req.op.as_str() {
        "hello" => {
            let accepts: Vec<String> = req
                .fields
                .get("accepts")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(ToString::to_string)
                        .collect()
                })
                .unwrap_or_default();
            wire.apply_hello(accepts);

            let after_seq = req
                .fields
                .get("afterSeq")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let raw_shell = match state.coordinator.shell(may_answer).await {
                Ok(s) => s,
                Err(err) => return HostResponseEnvelope::err(req.id, err.code, err.message),
            };
            let shell = wire.encode_reply_shell(raw_shell);
            let (events, has_more, latest_seq) = state
                .coordinator
                .events(None, after_seq, 200)
                .await
                .unwrap_or_default();
            let memory_version = state.memory.lock().unwrap().schema_version().unwrap_or(0);
            let subagents_ok = state
                .subagents
                .lock()
                .unwrap()
                .quick_check()
                .map(|s| s == "ok")
                .unwrap_or(false);
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
                    "shell": shell,
                    "stores": {
                        "memorySchemaVersion": memory_version,
                        "subagentsOk": subagents_ok,
                        "credentialsSecure": credentials_secure,
                    },
                }),
            )
        }
        "ping" => HostResponseEnvelope::ok(req.id, json!({ "pong": true })),
        "shell" | "state" => match state.coordinator.shell(may_answer).await {
            Ok(raw_shell) => HostResponseEnvelope::ok(req.id, wire.encode_reply_shell(raw_shell)),
            Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
        },
        "observe" => {
            let Some(arr) = req.fields.get("threadIds").and_then(Value::as_array) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let thread_ids: Vec<String> = arr
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect();
            let previously_observed = wire.observed.clone();
            wire.set_observed(&thread_ids);

            let details = match state.coordinator.observe(thread_ids.clone()).await {
                Ok(list) => list,
                Err(err) => return HostResponseEnvelope::err(req.id, err.code, err.message),
            };
            // Protocol v1 promise: push every newly observed thread's detail BEFORE answering `observe`
            // (unless `detail-read-held` confirmed the client already holds this exact revision).
            for (tid, detail) in details {
                if !previously_observed.contains(&tid) {
                    if let Some(push_frame) = wire.encode_observe_detail_push(&tid, detail.as_ref()) {
                        if let Ok(encoded) = serde_json::to_string(&push_frame) {
                            let _ = out_tx.send(OutboundFrame::Text(encoded));
                        }
                    }
                }
            }
            HostResponseEnvelope::ok(req.id, Value::Null)
        }
        "detail" => {
            let Some(thread_id) = req.fields.get("threadId").and_then(Value::as_str) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            match state.coordinator.detail(thread_id.to_string()).await {
                Ok(Some(detail)) => {
                    let formatted = wire.record_detail_read(&detail);
                    HostResponseEnvelope::ok(
                        req.id,
                        serde_json::to_value(formatted).unwrap_or(Value::Null),
                    )
                }
                Ok(None) => HostResponseEnvelope::ok(req.id, Value::Null),
                Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
            }
        }
        "events" => {
            let thread_id = req
                .fields
                .get("threadId")
                .and_then(Value::as_str)
                .map(ToString::to_string);
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
            match state.coordinator.events(thread_id, after_seq, limit).await {
                Ok((events, has_more, latest_seq)) => HostResponseEnvelope::ok(
                    req.id,
                    json!({
                        "events": events,
                        "hasMore": has_more,
                        "latestSeq": latest_seq,
                    }),
                ),
                Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
            }
        }
        "stage-attachment" => {
            let Some(img) = req.fields.get("image").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let (Some(name), Some(mime), Some(data)) = (
                img.get("name").and_then(Value::as_str),
                img.get("mimeType").and_then(Value::as_str),
                img.get("data").and_then(Value::as_str),
            ) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let dimensions = img.get("dimensions").cloned();
            match state
                .coordinator
                .stage_image(name.into(), mime.into(), data.into(), dimensions)
                .await
            {
                Ok(handle) => HostResponseEnvelope::ok(
                    req.id,
                    serde_json::to_value(handle).unwrap_or(Value::Null),
                ),
                Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
            }
        }
        "attachment-content" => {
            let Some(digest) = req.fields.get("digest").and_then(Value::as_str) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            match state
                .coordinator
                .attachment_content(digest.to_string())
                .await
            {
                Ok(Some((mime, bytes))) => HostResponseEnvelope::ok(
                    req.id,
                    json!({
                        "mimeType": mime,
                        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                    }),
                ),
                Ok(None) => HostResponseEnvelope::ok(req.id, Value::Null),
                Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
            }
        }
        "stage-file-part" => {
            let Some(part) = req.fields.get("part").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let (
                Some(upload_id),
                Some(index),
                Some(count),
                Some(name),
                Some(mime),
                Some(size_bytes_u64),
                Some(digest),
                Some(data),
            ) = (
                part.get("uploadId").and_then(Value::as_str),
                part.get("index").and_then(Value::as_u64),
                part.get("count").and_then(Value::as_u64),
                part.get("name").and_then(Value::as_str),
                part.get("mimeType").and_then(Value::as_str),
                part.get("sizeBytes").and_then(Value::as_u64),
                part.get("digest").and_then(Value::as_str),
                part.get("data").and_then(Value::as_str),
            )
            else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Ok(size_bytes) = usize::try_from(size_bytes_u64) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    "Uploaded file exceeds the allowed size limit.",
                );
            };
            let Ok(index_usize) = usize::try_from(index) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    "Invalid file upload part index.",
                );
            };
            let Ok(count_usize) = usize::try_from(count) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    "Invalid file upload part count.",
                );
            };
            match state
                .coordinator
                .stage_file_part(
                    upload_id.into(),
                    index_usize,
                    count_usize,
                    name.into(),
                    mime.into(),
                    size_bytes,
                    digest.into(),
                    data.into(),
                )
                .await
            {
                Ok(Some(handle)) => HostResponseEnvelope::ok(
                    req.id,
                    serde_json::to_value(handle).unwrap_or(Value::Null),
                ),
                Ok(None) => HostResponseEnvelope::ok(req.id, Value::Null),
                Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
            }
        }
        "command" => {
            let Some(cmd) = req.fields.get("command").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let client = ClientContext {
                client_id: client_id.to_string(),
                user: client_name.to_string(),
                may_answer,
            };
            match state.coordinator.run_command(client, cmd.clone()).await {
                Ok(raw_shell) => {
                    HostResponseEnvelope::ok(req.id, wire.encode_command_shell(raw_shell))
                }
                Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
            }
        }
        "host-facts" => {
            let running = state
                .coordinator
                .running_threads_count()
                .await
                .unwrap_or(0);
            let facts = tokio::task::spawn_blocking(move || sotto_core::ops::host_facts(running))
                .await
                .unwrap_or_else(|_| json!({}));
            HostResponseEnvelope::ok(req.id, facts)
        }
        "host-folders" => {
            let req_obj = req.fields.get("request").and_then(Value::as_object);
            let requested: Option<Option<String>> = match req_obj.and_then(|r| r.get("path")) {
                Some(Value::Null) => Some(None),
                Some(Value::String(s)) => Some(Some(s.clone())),
                _ => None,
            };
            let fallback = state.data_directory.clone();
            match tokio::task::spawn_blocking(move || {
                let borrowed = requested.as_ref().map(|opt| opt.as_deref());
                sotto_core::ops::host_folders(borrowed, &fallback)
            })
            .await
            {
                Ok(val) => HostResponseEnvelope::ok(req.id, val),
                Err(_) => HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    HostErrorCode::Unavailable.default_message(),
                ),
            }
        }
        "git-refs" => {
            let Some(r) = req.fields.get("request").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Some(tid) = r.get("threadId").and_then(Value::as_str) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Ok(Some(ws)) = state.coordinator.thread_workspace(tid.to_string()).await else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    "This thread is unavailable.",
                );
            };
            let query = r.get("query").and_then(Value::as_str).map(ToString::to_string);
            let cursor = r.get("cursor").and_then(Value::as_u64).map(|v| v as usize);
            let limit = r.get("limit").and_then(Value::as_u64).map(|v| v as usize);
            let include_matching_remote = r
                .get("includeMatchingRemoteRefs")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let folder = ws.working_directory;
            match tokio::task::spawn_blocking(move || {
                sotto_core::ops::git_refs(
                    &folder,
                    query.as_deref(),
                    cursor,
                    limit,
                    include_matching_remote,
                )
            })
            .await
            {
                Ok(Ok(val)) => HostResponseEnvelope::ok(req.id, val),
                _ => HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    HostErrorCode::Unavailable.default_message(),
                ),
            }
        }
        "git-changed-files" => {
            let Some(tid) = req
                .fields
                .get("request")
                .and_then(|r| r.get("threadId"))
                .and_then(Value::as_str)
            else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Ok(Some(ws)) = state.coordinator.thread_workspace(tid.to_string()).await else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    "This thread is unavailable.",
                );
            };
            let folder = ws.working_directory;
            match tokio::task::spawn_blocking(move || sotto_core::ops::git_changed_files(&folder))
                .await
            {
                Ok(Ok(val)) => HostResponseEnvelope::ok(req.id, val),
                _ => HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    HostErrorCode::Unavailable.default_message(),
                ),
            }
        }
        "thread-files" => {
            let Some(r) = req.fields.get("request").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Some(tid) = r.get("threadId").and_then(Value::as_str) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let rel = r.get("path").and_then(Value::as_str).unwrap_or("").to_string();
            let req_ws_id = r.get("workspaceId").and_then(Value::as_str);
            if !rel.is_empty() && req_ws_id.is_none() {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err("invalid-request", "Refresh the workspace first."),
                );
            }
            let Ok(Some(ws)) = state.coordinator.thread_workspace(tid.to_string()).await else {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err("thread-unavailable", "This thread is unavailable."),
                );
            };
            if let Some(expected_ws) = req_ws_id {
                if expected_ws != ws.workspace_id {
                    return HostResponseEnvelope::ok(
                        req.id,
                        sotto_core::ops::tools_err(
                            "workspace-changed",
                            "This thread's working folder changed. Refresh and try again.",
                        ),
                    );
                }
            }
            let res = tokio::task::spawn_blocking(move || sotto_core::ops::thread_files(&ws, &rel))
                .await
                .unwrap_or_else(|_| sotto_core::ops::tools_err("unavailable", "Could not read files."));
            HostResponseEnvelope::ok(req.id, res)
        }
        "thread-file-preview" => {
            let Some(r) = req.fields.get("request").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let (Some(tid), Some(rel), Some(expected_ws)) = (
                r.get("threadId").and_then(Value::as_str),
                r.get("path").and_then(Value::as_str),
                r.get("workspaceId").and_then(Value::as_str),
            ) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Ok(Some(ws)) = state.coordinator.thread_workspace(tid.to_string()).await else {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err("thread-unavailable", "This thread is unavailable."),
                );
            };
            if expected_ws != ws.workspace_id {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err(
                        "workspace-changed",
                        "This thread's working folder changed. Refresh and try again.",
                    ),
                );
            }
            let rel_owned = rel.to_string();
            let res = tokio::task::spawn_blocking(move || {
                sotto_core::ops::thread_file_preview(&ws, &rel_owned)
            })
            .await
            .unwrap_or_else(|_| sotto_core::ops::tools_err("unavailable", "Could not preview file."));
            HostResponseEnvelope::ok(req.id, res)
        }
        "thread-changes" => {
            let Some(r) = req.fields.get("request").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Some(tid) = r.get("threadId").and_then(Value::as_str) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let req_ws_id = r.get("workspaceId").and_then(Value::as_str);
            let Ok(Some(ws)) = state.coordinator.thread_workspace(tid.to_string()).await else {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err("thread-unavailable", "This thread is unavailable."),
                );
            };
            if let Some(expected_ws) = req_ws_id {
                if expected_ws != ws.workspace_id {
                    return HostResponseEnvelope::ok(
                        req.id,
                        sotto_core::ops::tools_err(
                            "workspace-changed",
                            "This thread's working folder changed. Refresh and try again.",
                        ),
                    );
                }
            }
            let res = tokio::task::spawn_blocking(move || sotto_core::ops::thread_changes(&ws))
                .await
                .unwrap_or_else(|_| sotto_core::ops::tools_err("unavailable", "Could not read changes."));
            HostResponseEnvelope::ok(req.id, res)
        }
        "thread-changes-review" => {
            let Some(r) = req.fields.get("request").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let (Some(tid), Some(expected_ws)) = (
                r.get("threadId").and_then(Value::as_str),
                r.get("workspaceId").and_then(Value::as_str),
            ) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let scope = r
                .get("scope")
                .cloned()
                .unwrap_or_else(|| json!({ "kind": "working" }));
            let ignore_whitespace = r
                .get("ignoreWhitespace")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let Ok(Some(ws)) = state.coordinator.thread_workspace(tid.to_string()).await else {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err("thread-unavailable", "This thread is unavailable."),
                );
            };
            if expected_ws != ws.workspace_id {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err(
                        "workspace-changed",
                        "This thread's working folder changed. Refresh and try again.",
                    ),
                );
            }
            let res = tokio::task::spawn_blocking(move || {
                sotto_core::ops::thread_changes_review(&ws, &scope, ignore_whitespace)
            })
            .await
            .unwrap_or_else(|_| sotto_core::ops::tools_err("unavailable", "Could not read review."));
            HostResponseEnvelope::ok(req.id, res)
        }
        "thread-words" => {
            let Some(query) = req
                .fields
                .get("query")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|q| !q.is_empty())
                .map(ToString::to_string)
            else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let dir = state.data_directory.clone();
            let res = tokio::task::spawn_blocking(move || {
                sotto_core::ops::search_thread_words(&dir, &query)
            })
            .await
            .unwrap_or_else(|_| json!({ "found": [] }));
            HostResponseEnvelope::ok(req.id, res)
        }
        "subagent-page" => {
            let Some(tid) = req
                .fields
                .get("request")
                .and_then(|r| r.get("threadId"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
            else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let dir = state.data_directory.clone();
            let res = tokio::task::spawn_blocking(move || {
                sotto_core::ops::read_subagent_page(&dir, &tid)
            })
            .await
            .unwrap_or_else(|_| {
                json!({
                    "threadId": "",
                    "revision": 0,
                    "rows": [],
                    "summary": { "total": 0, "working": 0, "completed": 0, "failed": 0, "interrupted": 0, "unknown": 0 }
                })
            });
            HostResponseEnvelope::ok(req.id, res)
        }
        "subagent-assignments" => {
            let Some(r) = req.fields.get("request").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let (Some(tid), Some(aid)) = (
                r.get("threadId").and_then(Value::as_str),
                r.get("agentId").and_then(Value::as_str),
            ) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let res = sotto_core::ops::read_subagent_assignments(tid, aid);
            HostResponseEnvelope::ok(req.id, res)
        }
        "usage-read" => {
            let tz = req
                .fields
                .get("query")
                .and_then(|q| q.get("timeZone"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let dir = state.data_directory.clone();
            let res = tokio::task::spawn_blocking(move || {
                sotto_core::ops::usage_read(&dir, tz.as_deref())
            })
            .await
            .unwrap_or_else(|_| json!({ "status": "error", "quotas": [] }));
            HostResponseEnvelope::ok(req.id, res)
        }
        "usage-refresh" => {
            let dir = state.data_directory.clone();
            let res = tokio::task::spawn_blocking(move || sotto_core::ops::usage_read(&dir, None))
                .await
                .unwrap_or_else(|_| json!({ "status": "error", "quotas": [] }));
            HostResponseEnvelope::ok(req.id, res)
        }
        "usage-clear" => {
            if !may_answer {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Forbidden,
                    HostErrorCode::Forbidden.default_message(),
                );
            }
            let Some(expected_rev) = req
                .fields
                .get("request")
                .and_then(|r| r.get("expectedRevision"))
                .and_then(Value::as_i64)
            else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let dir = state.data_directory.clone();
            let res = tokio::task::spawn_blocking(move || {
                sotto_core::ops::usage_clear(&dir, expected_rev)
            })
            .await
            .unwrap_or_else(|_| {
                json!({
                    "status": "stale",
                    "metadata": {
                        "startedAt": sotto_core::workspace::now_iso(),
                        "revision": 0,
                        "generation": 0,
                        "legacySeedCompleted": false,
                    }
                })
            });
            HostResponseEnvelope::ok(req.id, res)
        }
        _ => HostResponseEnvelope::err(
            req.id,
            HostErrorCode::InvalidRequest,
            HostErrorCode::InvalidRequest.default_message(),
        ),
    }
}

fn is_allowed_origin(origin: Option<&str>) -> bool {
    let Some(raw) = origin else {
        return true;
    };
    let rest = raw
        .strip_prefix("http://")
        .or_else(|| raw.strip_prefix("https://"));
    let Some(host_port) = rest else {
        return false;
    };
    if host_port.contains('/') || host_port.contains('@') || host_port.contains('?') {
        return false;
    }
    let host = if let Some(after_bracket) = host_port.strip_prefix('[') {
        let Some((ipv6, tail)) = after_bracket.split_once(']') else {
            return false;
        };
        if !tail.is_empty() && !tail.strip_prefix(':').is_some_and(|p| p.parse::<u16>().is_ok()) {
            return false;
        }
        ipv6
    } else if let Some((h, p)) = host_port.split_once(':') {
        if p.parse::<u16>().is_err() {
            return false;
        }
        h
    } else {
        host_port
    };
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
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
