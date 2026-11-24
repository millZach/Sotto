//! Protocol v1 HTTP + WebSocket (`permessage-deflate`) remote host client and
//! `DesktopHostRouter` multiplexing local + connected remote hosts under
//! `host:<hostId>:<id>` client entity keys.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use flate2::{Decompress, FlushDecompress, Status};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};

use crate::coordinator::{ClientContext, CoordinatorHandle};
use crate::council::{host_entity_key, parse_host_entity_key};
use crate::desktop_hosts::{FilesBindingsDelta, FilesBindingsTracker, HostThreadFoldersEntry, SshTerminalHostEntry};
use crate::protocol::{HOST_MAX_FRAME_BYTES, HOST_PROTOCOL_VERSION};

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFLATE_OFFER: &str =
    "permessage-deflate; client_no_context_takeover; server_no_context_takeover";
const DEFLATE_TAIL: [u8; 4] = [0x00, 0x00, 0xff, 0xff];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConnectionSummary {
    pub host_id: String,
    pub name: String,
    pub kind: String,
    pub connected: bool,
}

#[derive(Debug, Clone)]
pub enum RemoteHostEvent {
    Shell { host_id: String, shell: Value },
    Detail { host_id: String, detail: Value },
    Disconnected { host_id: String },
}

#[derive(Debug, Clone)]
pub struct RemoteHostInfo {
    pub host_id: String,
    pub client_id: String,
    pub name: String,
    pub sotto_version: String,
    pub may_answer: bool,
    pub features: Vec<String>,
}

// ---------------------------------------------------------------------------
// Minimal HTTP/1.1 + RFC 6455 WebSocket Client (with RFC 7692 permessage-deflate)
// ---------------------------------------------------------------------------

fn parse_http_url(url: &str) -> Result<(String, u16), String> {
    let stripped = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("Only http:// host URLs are supported by local TCP client: {url}"))?;
    let authority = stripped.split('/').next().unwrap_or("");
    if authority.is_empty() {
        return Err(format!("Missing host in URL: {url}"));
    }
    if let Some(rest) = authority.strip_prefix('[') {
        let end = rest
            .find(']')
            .ok_or_else(|| format!("Invalid IPv6 host in URL: {url}"))?;
        let host = rest[..end].to_string();
        let port = rest[end + 1..]
            .strip_prefix(':')
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(80);
        return Ok((host, port));
    }
    match authority.rsplit_once(':') {
        Some((h, p)) => {
            let port = p
                .parse::<u16>()
                .map_err(|_| format!("Invalid port in URL: {url}"))?;
            Ok((h.to_string(), port))
        }
        None => Ok((authority.to_string(), 80)),
    }
}

async fn http_json_request(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Option<&str>,
) -> Result<(u16, Value), String> {
    let mut stream = tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect((host, port)),
    )
    .await
    .map_err(|_| "Timed out connecting to remote host.".to_string())?
    .map_err(|e| format!("Could not connect to remote host: {e}"))?;

    let payload = body.unwrap_or("");
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nContent-Length: {}\r\n",
        payload.len()
    );
    if !payload.is_empty() {
        req.push_str("Content-Type: application/json\r\n");
    }
    if let Some(tok) = bearer {
        req.push_str(&format!("Authorization: Bearer {tok}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(payload);

    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| format!("Could not write HTTP request: {e}"))?;

    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), stream.read_to_end(&mut raw))
        .await
        .map_err(|_| "Timed out reading HTTP response from remote host.".to_string())?
        .map_err(|e| format!("Could not read HTTP response: {e}"))?;

    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "Malformed HTTP response from remote host.".to_string())?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status: u16 = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "Missing HTTP status line.".to_string())?;
    let resp_body = &raw[split + 4..];
    let json_val: Value = if resp_body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(resp_body).unwrap_or(Value::Null)
    };
    Ok((status, json_val))
}

fn ws_accept_expected(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(WS_GUID.as_bytes());
    STANDARD.encode(hasher.finalize())
}

async fn write_client_ws_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    opcode: u8,
    payload: &[u8],
) -> std::io::Result<()> {
    let mut mask = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut mask);

    let mut frame = Vec::with_capacity(14 + payload.len());
    frame.push(0x80 | (opcode & 0x0f));
    let len = payload.len();
    if len < 126 {
        frame.push(0x80 | (len as u8));
    } else if len <= 65_535 {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend_from_slice(&(len as u64).to_be_bytes());
    }
    frame.extend_from_slice(&mask);
    for (i, b) in payload.iter().enumerate() {
        frame.push(b ^ mask[i & 3]);
    }
    writer.write_all(&frame).await?;
    writer.flush().await
}

fn inflate_raw_deflate(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut combined = Vec::with_capacity(input.len() + 4);
    combined.extend_from_slice(input);
    combined.extend_from_slice(&DEFLATE_TAIL);

    let mut decompressor = Decompress::new(false);
    let mut out = Vec::with_capacity(input.len().saturating_mul(2).max(256));
    let mut offset = 0usize;
    let mut chunk = [0u8; 16_384];
    loop {
        let before_in = decompressor.total_in() as usize;
        let before_out = decompressor.total_out() as usize;
        let status = decompressor
            .decompress(&combined[offset..], &mut chunk, FlushDecompress::Sync)
            .map_err(|e| format!("Invalid permessage-deflate payload: {e}"))?;
        let produced = (decompressor.total_out() as usize) - before_out;
        let consumed = (decompressor.total_in() as usize) - before_in;
        offset += consumed;
        if out.len() + produced > HOST_MAX_FRAME_BYTES {
            return Err("Inflated WebSocket message exceeds limit.".into());
        }
        out.extend_from_slice(&chunk[..produced]);
        if status == Status::StreamEnd || (offset >= combined.len() && produced == 0) {
            break;
        }
    }
    Ok(out)
}

enum ServerWsFrame {
    Text(String),
    Ping(Vec<u8>),
    Pong,
    Close,
}

async fn read_server_ws_message<R: AsyncRead + Unpin>(
    reader: &mut R,
    deflate: bool,
) -> Result<ServerWsFrame, String> {
    let mut frag_opcode: Option<u8> = None;
    let mut frag_compressed = false;
    let mut frag_buf: Vec<u8> = Vec::new();

    loop {
        let mut hdr = [0u8; 2];
        if let Err(err) = reader.read_exact(&mut hdr).await {
            if err.kind() == std::io::ErrorKind::UnexpectedEof {
                return Ok(ServerWsFrame::Close);
            }
            return Err(format!("WebSocket read error: {err}"));
        }
        let fin = (hdr[0] & 0x80) != 0;
        let rsv1 = (hdr[0] & 0x40) != 0;
        let opcode = hdr[0] & 0x0f;
        let masked = (hdr[1] & 0x80) != 0;
        let len7 = hdr[1] & 0x7f;
        let payload_len = if len7 < 126 {
            len7 as usize
        } else if len7 == 126 {
            let mut ext = [0u8; 2];
            reader
                .read_exact(&mut ext)
                .await
                .map_err(|e| format!("WebSocket length read error: {e}"))?;
            u16::from_be_bytes(ext) as usize
        } else {
            let mut ext = [0u8; 8];
            reader
                .read_exact(&mut ext)
                .await
                .map_err(|e| format!("WebSocket length read error: {e}"))?;
            u64::from_be_bytes(ext) as usize
        };
        if payload_len > HOST_MAX_FRAME_BYTES {
            return Err("WebSocket frame exceeds limit.".into());
        }
        let mask_key = if masked {
            let mut k = [0u8; 4];
            reader
                .read_exact(&mut k)
                .await
                .map_err(|e| format!("WebSocket mask read error: {e}"))?;
            Some(k)
        } else {
            None
        };
        let mut payload = vec![0u8; payload_len];
        if payload_len > 0 {
            reader
                .read_exact(&mut payload)
                .await
                .map_err(|e| format!("WebSocket payload read error: {e}"))?;
        }
        if let Some(k) = mask_key {
            for (i, b) in payload.iter_mut().enumerate() {
                *b ^= k[i & 3];
            }
        }

        match opcode {
            0x8 => return Ok(ServerWsFrame::Close),
            0x9 => return Ok(ServerWsFrame::Ping(payload)),
            0xA => return Ok(ServerWsFrame::Pong),
            0x1 | 0x2 => {
                if fin {
                    let bytes = if rsv1 && deflate {
                        inflate_raw_deflate(&payload)?
                    } else {
                        payload
                    };
                    let text = String::from_utf8(bytes)
                        .map_err(|e| format!("Invalid UTF-8 in WebSocket text frame: {e}"))?;
                    return Ok(ServerWsFrame::Text(text));
                }
                frag_opcode = Some(opcode);
                frag_compressed = rsv1 && deflate;
                frag_buf.clear();
                frag_buf.extend_from_slice(&payload);
            }
            0x0 => {
                if frag_opcode.is_none() {
                    return Err("Unexpected continuation frame.".into());
                }
                if frag_buf.len() + payload.len() > HOST_MAX_FRAME_BYTES {
                    return Err("Fragmented WebSocket message exceeds limit.".into());
                }
                frag_buf.extend_from_slice(&payload);
                if fin {
                    let raw = std::mem::take(&mut frag_buf);
                    let compressed = frag_compressed;
                    let bytes = if compressed {
                        inflate_raw_deflate(&raw)?
                    } else {
                        raw
                    };
                    let text = String::from_utf8(bytes)
                        .map_err(|e| format!("Invalid UTF-8 in fragmented text frame: {e}"))?;
                    return Ok(ServerWsFrame::Text(text));
                }
            }
            _ => return Err(format!("Unsupported WebSocket opcode: {opcode}")),
        }
    }
}

// ---------------------------------------------------------------------------
// RemoteHostClient
// ---------------------------------------------------------------------------

enum OutgoingWs {
    Text(String),
    Pong(Vec<u8>),
    Close,
}

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

/// Live authenticated connection to a remote protocol v1 Sotto host (`sotto-host` or Node host).
#[derive(Clone)]
pub struct RemoteHostClient {
    info: RemoteHostInfo,
    shell: Arc<Mutex<Value>>,
    tx: mpsc::UnboundedSender<OutgoingWs>,
    pending: PendingMap,
    next_id: Arc<AtomicU64>,
    events: broadcast::Sender<RemoteHostEvent>,
    connected: Arc<std::sync::atomic::AtomicBool>,
}

impl RemoteHostClient {
    /// Connects to a remote protocol v1 host:
    /// 1. `GET /v1/health` (verifies `protocolVersion == 1` and optional `expected_host_id`)
    /// 2. `POST /v1/session` with pairing bearer token
    /// 3. `GET /v1/socket` WebSocket upgrade with `permessage-deflate`
    /// 4. `hello` handshake returning initial shell & capabilities
    pub async fn connect(
        url: &str,
        pairing_token: &str,
        expected_host_id: Option<&str>,
        name: impl Into<String>,
    ) -> Result<Self, String> {
        let (host, port) = parse_http_url(url)?;

        // 1. Health check (`HostDescriptor::public_health` returns `{ v: 1, status: "ready", hostId, ... }`;
        //    loopback phone listeners return `{ ok: true, protocolVersion: 1, hostId, ... }`).
        let (status, health) = http_json_request(&host, port, "GET", "/v1/health", None, None).await?;
        let healthy = status == 200
            && (health.get("status").and_then(Value::as_str) == Some("ready")
                || health.get("ok").and_then(Value::as_bool) == Some(true));
        if !healthy {
            return Err(format!("Remote host health check failed (HTTP {status})."));
        }
        let proto = health
            .get("v")
            .or_else(|| health.get("protocolVersion"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if proto != u64::from(HOST_PROTOCOL_VERSION) {
            return Err(format!(
                "Remote host speaks protocol version {proto}, expected {HOST_PROTOCOL_VERSION}."
            ));
        }
        let health_host_id = health
            .get("hostId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(expected) = expected_host_id {
            if health_host_id != expected {
                return Err("Remote host identity does not match saved hostId.".into());
            }
        }
        let sotto_version = health
            .get("sottoVersion")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        // 2. Exchange pairing token for short-lived session token.
        let (s_status, sess_json) =
            http_json_request(&host, port, "POST", "/v1/session", Some(pairing_token), None).await?;
        if s_status != 200 {
            return Err(format!(
                "Remote host rejected session request (HTTP {s_status})."
            ));
        }
        let session_token = sess_json
            .get("session")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Remote host session response omitted session token.".to_string())?;

        // 3. WebSocket upgrade.
        let mut key_bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut key_bytes);
        let ws_key = STANDARD.encode(key_bytes);

        let mut tcp = tokio::time::timeout(
            Duration::from_secs(10),
            TcpStream::connect((host.as_str(), port)),
        )
        .await
        .map_err(|_| "Timed out opening WebSocket to remote host.".to_string())?
        .map_err(|e| format!("Could not open WebSocket TCP connection: {e}"))?;

        let upgrade = format!(
            "GET /v1/socket HTTP/1.1\r\n\
             Host: {host}:{port}\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Authorization: Bearer {session_token}\r\n\
             Sec-WebSocket-Key: {ws_key}\r\n\
             Sec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Extensions: {DEFLATE_OFFER}\r\n\r\n"
        );
        tcp.write_all(upgrade.as_bytes())
            .await
            .map_err(|e| format!("Could not send WebSocket upgrade: {e}"))?;

        let mut reader = BufReader::new(tcp);
        let mut status_line = String::new();
        reader
            .read_line(&mut status_line)
            .await
            .map_err(|e| format!("Could not read WebSocket upgrade status: {e}"))?;
        if !status_line.starts_with("HTTP/1.1 101") {
            return Err(format!(
                "Remote host refused WebSocket upgrade: {}",
                status_line.trim()
            ));
        }
        let mut accept_header: Option<String> = None;
        let mut deflate_accepted = false;
        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .map_err(|e| format!("Could not read WebSocket response headers: {e}"))?;
            if line == "\r\n" || line == "\n" || line.is_empty() {
                break;
            }
            if let Some((k, v)) = line.split_once(':') {
                let kl = k.trim().to_ascii_lowercase();
                let vl = v.trim();
                if kl == "sec-websocket-accept" {
                    accept_header = Some(vl.to_string());
                } else if kl == "sec-websocket-extensions"
                    && vl.to_ascii_lowercase().contains("permessage-deflate")
                {
                    deflate_accepted = true;
                }
            }
        }
        if accept_header.as_deref() != Some(ws_accept_expected(&ws_key).as_str()) {
            return Err("Remote host returned invalid Sec-WebSocket-Accept.".into());
        }

        let (read_half, mut write_half) = tokio::io::split(reader);
        let mut read_half = read_half;
        let (tx, mut rx) = mpsc::unbounded_channel::<OutgoingWs>();
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let shell_slot = Arc::new(Mutex::new(Value::Null));
        let (events_tx, _) = broadcast::channel(128);
        let connected = Arc::new(std::sync::atomic::AtomicBool::new(true));

        // Writer task.
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                match msg {
                    OutgoingWs::Text(text) => {
                        if write_client_ws_frame(&mut write_half, 0x1, text.as_bytes())
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    OutgoingWs::Pong(data) => {
                        if write_client_ws_frame(&mut write_half, 0xA, &data)
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    OutgoingWs::Close => {
                        let _ = write_client_ws_frame(&mut write_half, 0x8, &[]).await;
                        break;
                    }
                }
            }
        });

        // Reader task.
        let r_pending = Arc::clone(&pending);
        let r_shell = Arc::clone(&shell_slot);
        let r_tx = tx.clone();
        let r_events = events_tx.clone();
        let r_connected = Arc::clone(&connected);
        let r_host_id = health_host_id.clone();
        tokio::spawn(async move {
            loop {
                match read_server_ws_message(&mut read_half, deflate_accepted).await {
                    Ok(ServerWsFrame::Text(text)) => {
                        let Ok(val) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        if let Some(id) = val.get("id").and_then(Value::as_str) {
                            let waiter = r_pending.lock().await.remove(id);
                            if let Some(w) = waiter {
                                if val.get("ok").and_then(Value::as_bool) == Some(true) {
                                    let _ = w.send(Ok(val
                                        .get("result")
                                        .cloned()
                                        .unwrap_or(Value::Null)));
                                } else {
                                    let msg = val
                                        .get("error")
                                        .and_then(|e| e.get("message"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("Remote host request failed.")
                                        .to_string();
                                    let _ = w.send(Err(msg));
                                }
                            }
                        } else if let Some(push) = val.get("push").and_then(Value::as_str) {
                            let payload = val.get("payload").cloned().unwrap_or(Value::Null);
                            match push {
                                "shell" => {
                                    *r_shell.lock().await = payload.clone();
                                    let _ = r_events.send(RemoteHostEvent::Shell {
                                        host_id: r_host_id.clone(),
                                        shell: payload,
                                    });
                                }
                                "detail" => {
                                    let _ = r_events.send(RemoteHostEvent::Detail {
                                        host_id: r_host_id.clone(),
                                        detail: payload,
                                    });
                                }
                                _ => {}
                            }
                        }
                    }
                    Ok(ServerWsFrame::Ping(data)) => {
                        let _ = r_tx.send(OutgoingWs::Pong(data));
                    }
                    Ok(ServerWsFrame::Pong) => {}
                    Ok(ServerWsFrame::Close) | Err(_) => break,
                }
            }
            r_connected.store(false, Ordering::SeqCst);
            let mut map = r_pending.lock().await;
            for (_, w) in map.drain() {
                let _ = w.send(Err("Remote host disconnected.".into()));
            }
            let _ = r_events.send(RemoteHostEvent::Disconnected { host_id: r_host_id });
        });

        let client = Self {
            info: RemoteHostInfo {
                host_id: health_host_id,
                client_id: String::new(),
                name: name.into(),
                sotto_version,
                may_answer: false,
                features: Vec::new(),
            },
            shell: shell_slot,
            tx,
            pending,
            next_id: Arc::new(AtomicU64::new(1)),
            events: events_tx,
            connected,
        };

        // 4. Send `hello` handshake.
        let hello = client
            .request(
                "hello",
                json!({
                    "accepts": ["detail-delta", "files-list", "git-changes", "host-facts", "usage-read"],
                }),
            )
            .await?;

        let host_id = hello
            .get("hostId")
            .and_then(Value::as_str)
            .unwrap_or(&client.info.host_id)
            .to_string();
        let client_id = hello
            .get("clientId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let may_answer = hello
            .get("capabilities")
            .and_then(|c| c.get("mayAnswer"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let features: Vec<String> = hello
            .get("features")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(ToString::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if let Some(initial_shell) = hello.get("shell") {
            *client.shell.lock().await = initial_shell.clone();
        }

        let mut finalized = client;
        finalized.info.host_id = host_id;
        finalized.info.client_id = client_id;
        finalized.info.may_answer = may_answer;
        finalized.info.features = features;
        Ok(finalized)
    }

    pub fn info(&self) -> &RemoteHostInfo {
        &self.info
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RemoteHostEvent> {
        self.events.subscribe()
    }

    pub async fn cached_shell(&self) -> Value {
        self.shell.lock().await.clone()
    }

    pub async fn request(&self, op: &str, payload: Value) -> Result<Value, String> {
        if !self.is_connected() {
            return Err("Remote host is disconnected.".into());
        }
        let seq = self.next_id.fetch_add(1, Ordering::Relaxed);
        let id = format!("r-{seq}");
        let (resp_tx, resp_rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), resp_tx);

        let mut envelope = Map::new();
        envelope.insert("v".into(), json!(HOST_PROTOCOL_VERSION));
        envelope.insert("id".into(), json!(id));
        envelope.insert("op".into(), json!(op));
        if let Value::Object(extra) = payload {
            for (k, v) in extra {
                envelope.insert(k, v);
            }
        }
        let text = serde_json::to_string(&Value::Object(envelope))
            .map_err(|e| format!("Could not serialize remote host request: {e}"))?;
        if self.tx.send(OutgoingWs::Text(text)).is_err() {
            self.pending.lock().await.remove(&format!("r-{seq}"));
            return Err("Remote host connection closed.".into());
        }
        match tokio::time::timeout(Duration::from_secs(20), resp_rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("Remote host closed before answering.".into()),
            Err(_) => {
                self.pending.lock().await.remove(&format!("r-{seq}"));
                Err(format!("Remote host timed out answering {op}."))
            }
        }
    }

    pub async fn command(&self, cmd: Value) -> Result<Value, String> {
        let res = self.request("command", json!({ "command": cmd })).await?;
        let shell = if let Some(s) = res.get("shell") {
            s.clone()
        } else if res.get("host").is_some() {
            res.clone()
        } else {
            return Ok(res);
        };
        *self.shell.lock().await = shell.clone();
        Ok(shell)
    }

    pub async fn detail(&self, thread_id: &str) -> Result<Value, String> {
        self.request("detail", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn observe(&self, thread_ids: &[String]) -> Result<Value, String> {
        self.request("observe", json!({ "threadIds": thread_ids }))
            .await
    }

    pub async fn host_facts(&self) -> Result<Value, String> {
        self.request("host-facts", json!({})).await
    }

    pub fn close(&self) {
        self.connected.store(false, Ordering::SeqCst);
        let _ = self.tx.send(OutgoingWs::Close);
    }
}

// ---------------------------------------------------------------------------
// Host Entity Key Projection Helpers (matching src/shared/clientIdentity.ts)
// ---------------------------------------------------------------------------

fn key_thread_value(thread: &Value, host_id: &str, host_label: &str, remote: bool) -> Value {
    let mut out = thread.clone();
    let Some(obj) = out.as_object_mut() else {
        return out;
    };
    if let Some(tid) = obj.get("id").and_then(Value::as_str).map(ToString::to_string) {
        obj.insert("id".into(), Value::String(host_entity_key(Some(host_id), &tid)));
    }
    if let Some(pid) = obj
        .get("projectId")
        .and_then(Value::as_str)
        .map(ToString::to_string)
    {
        obj.insert(
            "projectId".into(),
            Value::String(host_entity_key(Some(host_id), &pid)),
        );
    }
    if let Some(del) = obj
        .get("delegatedBy")
        .and_then(Value::as_str)
        .map(ToString::to_string)
    {
        if parse_host_entity_key(&del).is_none() {
            obj.insert(
                "delegatedBy".into(),
                Value::String(host_entity_key(Some(host_id), &del)),
            );
        }
    }
    obj.insert("hostId".into(), Value::String(host_id.to_string()));
    obj.insert("hostLabel".into(), Value::String(host_label.to_string()));
    obj.insert("remoteHost".into(), Value::Bool(remote));
    out
}

fn key_project_value(project: &Value, host_id: &str) -> Value {
    let mut out = project.clone();
    if let Some(obj) = out.as_object_mut() {
        if let Some(pid) = obj.get("id").and_then(Value::as_str).map(ToString::to_string) {
            obj.insert("id".into(), Value::String(host_entity_key(Some(host_id), &pid)));
        }
        obj.insert("hostId".into(), Value::String(host_id.to_string()));
    }
    out
}

fn unkey_command_for_host(cmd: &Map<String, Value>, target_host_id: &str) -> Map<String, Value> {
    let mut out = cmd.clone();
    for field in ["threadId", "projectId", "activeThreadId", "activeProjectId", "draftThreadId"] {
        if let Some(raw) = out.get(field).and_then(Value::as_str).map(ToString::to_string) {
            if let Some((hid, inner)) = parse_host_entity_key(&raw) {
                if hid == target_host_id {
                    out.insert(field.into(), Value::String(inner));
                }
            }
        }
    }
    out.remove("hostId");
    out
}

// ---------------------------------------------------------------------------
// DesktopHostRouter
// ---------------------------------------------------------------------------

struct RegisteredRemoteHost {
    saved_id: String,
    name: String,
    client: RemoteHostClient,
    ssh_terminal: Option<SshTerminalHostEntry>,
}

/// Multiplexes this computer's local `CoordinatorHandle` with zero or more connected
/// `RemoteHostClient`s under `host:<hostId>:<id>` client entity keys.
pub struct DesktopHostRouter {
    local_host_id: String,
    local_name: String,
    local: CoordinatorHandle,
    remotes: HashMap<String, RegisteredRemoteHost>,
    files_tracker: FilesBindingsTracker,
}

impl DesktopHostRouter {
    pub fn new(
        local_host_id: String,
        local_name: impl Into<String>,
        local: CoordinatorHandle,
    ) -> Self {
        Self {
            local_host_id,
            local_name: local_name.into(),
            local,
            remotes: HashMap::new(),
            files_tracker: FilesBindingsTracker::default(),
        }
    }

    pub fn local_host_id(&self) -> &str {
        &self.local_host_id
    }

    pub fn attach_remote(
        &mut self,
        saved_id: String,
        name: String,
        client: RemoteHostClient,
        ssh_terminal: Option<SshTerminalHostEntry>,
    ) -> String {
        let host_id = client.info().host_id.clone();
        self.remotes.insert(
            host_id.clone(),
            RegisteredRemoteHost {
                saved_id,
                name,
                client,
                ssh_terminal,
            },
        );
        host_id
    }

    pub fn detach_remote(&mut self, host_id: &str) -> Option<String> {
        let removed = self.remotes.remove(host_id)?;
        removed.client.close();
        Some(removed.saved_id)
    }

    pub fn detach_by_saved_id(&mut self, saved_id: &str) -> Option<String> {
        let hid = self
            .remotes
            .iter()
            .find(|(_, r)| r.saved_id == saved_id)
            .map(|(k, _)| k.clone())?;
        self.detach_remote(&hid);
        Some(hid)
    }

    pub fn remote_client(&self, host_id: &str) -> Option<RemoteHostClient> {
        self.remotes.get(host_id).map(|r| r.client.clone())
    }

    pub fn connected_remote_ids(&self) -> Vec<String> {
        self.remotes
            .iter()
            .filter(|(_, r)| r.client.is_connected())
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Combines local and all connected remote shells into a unified host-keyed `AgentState`.
    pub async fn combined_shell(&mut self) -> Result<Value, String> {
        let local_shell = self
            .local
            .shell(true)
            .await
            .map_err(|e| e.message)?;

        let mut connections = vec![HostConnectionSummary {
            host_id: self.local_host_id.clone(),
            name: self.local_name.clone(),
            kind: "local".into(),
            connected: true,
        }];
        let mut combined_projects: Vec<Value> = Vec::new();
        let mut combined_threads: Vec<Value> = Vec::new();
        let mut combined_models: Vec<Value> = Vec::new();
        let mut combined_providers: Vec<Value> = Vec::new();

        if let Some(local_host) = local_shell.get("host") {
            if let Some(projs) = local_host.get("projects").and_then(Value::as_array) {
                for p in projs {
                    combined_projects.push(key_project_value(p, &self.local_host_id));
                }
            }
            if let Some(threads) = local_host.get("threads").and_then(Value::as_array) {
                for t in threads {
                    combined_threads.push(key_thread_value(
                        t,
                        &self.local_host_id,
                        &self.local_name,
                        false,
                    ));
                }
            }
            if let Some(models) = local_host.get("models").and_then(Value::as_array) {
                combined_models.extend(models.iter().cloned());
            }
            if let Some(providers) = local_host.get("providers").and_then(Value::as_array) {
                combined_providers.extend(providers.iter().cloned());
            }
        }

        let mut remote_keys: Vec<String> = self.remotes.keys().cloned().collect();
        remote_keys.sort();
        for host_id in remote_keys {
            let Some(reg) = self.remotes.get(&host_id) else {
                continue;
            };
            let is_up = reg.client.is_connected();
            connections.push(HostConnectionSummary {
                host_id: host_id.clone(),
                name: reg.name.clone(),
                kind: "remote".into(),
                connected: is_up,
            });
            let r_shell = reg.client.cached_shell().await;
            if let Some(r_host) = r_shell.get("host") {
                if let Some(projs) = r_host.get("projects").and_then(Value::as_array) {
                    for p in projs {
                        combined_projects.push(key_project_value(p, &host_id));
                    }
                }
                if let Some(threads) = r_host.get("threads").and_then(Value::as_array) {
                    for t in threads {
                        combined_threads.push(key_thread_value(t, &host_id, &reg.name, true));
                    }
                }
            }
        }

        let mut out = local_shell.clone();
        if let Some(obj) = out.as_object_mut() {
            obj.insert("hostId".into(), Value::String(self.local_host_id.clone()));
            obj.insert(
                "connections".into(),
                serde_json::to_value(&connections).unwrap_or(json!([])),
            );
            if let Some(host_obj) = obj.get_mut("host").and_then(Value::as_object_mut) {
                host_obj.insert("projects".into(), Value::Array(combined_projects));
                host_obj.insert("threads".into(), Value::Array(combined_threads));
                host_obj.insert("models".into(), Value::Array(combined_models));
                host_obj.insert("providers".into(), Value::Array(combined_providers));
            }
        }
        Ok(out)
    }

    /// Resolves which host owns a routed command (`threadId`, `projectId`, or explicit `hostId`).
    fn resolve_command_target(&self, cmd: &Map<String, Value>) -> String {
        if let Some(hid) = cmd.get("hostId").and_then(Value::as_str) {
            if !hid.is_empty() {
                return hid.to_string();
            }
        }
        for field in ["threadId", "projectId"] {
            if let Some(val) = cmd.get(field).and_then(Value::as_str) {
                if let Some((hid, _)) = parse_host_entity_key(val) {
                    return hid;
                }
            }
        }
        self.local_host_id.clone()
    }

    /// Routes an `AgentCommand` to either the local coordinator or the owning remote host,
    /// stripping `host:<hostId>:` prefixes before dispatch and returning the combined shell.
    pub async fn route_command(&mut self, cmd: Map<String, Value>) -> Result<Value, String> {
        let target = self.resolve_command_target(&cmd);
        let unkeyed = unkey_command_for_host(&cmd, &target);

        if target == self.local_host_id {
            let local_client = ClientContext {
                client_id: "local-desktop".into(),
                user: "Local Desktop".into(),
                may_answer: true,
            };
            let rx = self
                .local
                .enqueue_command(local_client, unkeyed)
                .map_err(|e| e.message)?;
            match rx.await {
                Ok(Ok(_)) => self.combined_shell().await,
                Ok(Err(e)) => Err(e.message),
                Err(_) => Err("Local host coordinator stopped.".into()),
            }
        } else {
            let Some(reg) = self.remotes.get(&target) else {
                return Err("This host is disconnected. Connect again to send commands.".into());
            };
            reg.client.command(Value::Object(unkeyed)).await?;
            self.combined_shell().await
        }
    }

    /// Routes a `detail` read by host-qualified thread key.
    pub async fn route_detail(&self, thread_key: &str) -> Result<Value, String> {
        let (target, raw_id) = match parse_host_entity_key(thread_key) {
            Some((hid, id)) => (hid, id),
            None => (self.local_host_id.clone(), thread_key.to_string()),
        };
        if target == self.local_host_id {
            let detail = self
                .local
                .detail(raw_id)
                .await
                .map_err(|e| e.message)?;
            let mut val = detail
                .and_then(|d| serde_json::to_value(d).ok())
                .unwrap_or(Value::Null);
            if let Some(obj) = val.as_object_mut() {
                if let Some(tid) = obj.get("threadId").and_then(Value::as_str).map(ToString::to_string) {
                    obj.insert(
                        "threadId".into(),
                        Value::String(host_entity_key(Some(&self.local_host_id), &tid)),
                    );
                }
            }
            Ok(val)
        } else {
            let Some(reg) = self.remotes.get(&target) else {
                return Err("This host is disconnected.".into());
            };
            let mut res = reg.client.detail(&raw_id).await?;
            let target_obj = if res.get("detail").and_then(Value::as_object).is_some() {
                res.get_mut("detail").and_then(Value::as_object_mut)
            } else {
                res.as_object_mut()
            };
            if let Some(detail_obj) = target_obj {
                if let Some(tid) = detail_obj
                    .get("threadId")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                {
                    detail_obj.insert(
                        "threadId".into(),
                        Value::String(host_entity_key(Some(&target), &tid)),
                    );
                }
            }
            Ok(res)
        }
    }

    /// Updates `FilesBindingsTracker` from local + remote shells and returns any incremental delta.
    pub async fn sync_files_bindings(&mut self) -> Option<FilesBindingsDelta> {
        let mut combined: Option<FilesBindingsDelta> = None;
        if let Ok(local_shell) = self.local.shell(true).await {
            if let Some(host) = local_shell.get("host") {
                combined = self.files_tracker.sync_local(host);
            }
        }
        let mut hosted: BTreeMap<String, HostThreadFoldersEntry> = BTreeMap::new();
        let mut terminals: BTreeMap<String, SshTerminalHostEntry> = BTreeMap::new();
        for (hid, reg) in &self.remotes {
            if let Some(ref term) = reg.ssh_terminal {
                terminals.insert(hid.clone(), term.clone());
            }
            let r_shell = reg.client.cached_shell().await;
            if let Some(r_host) = r_shell.get("host") {
                let mut proj_map: HashMap<String, String> = HashMap::new();
                if let Some(projs) = r_host.get("projects").and_then(Value::as_array) {
                    for p in projs {
                        if let (Some(id), Some(path)) = (
                            p.get("id").and_then(Value::as_str),
                            p.get("path").and_then(Value::as_str),
                        ) {
                            proj_map.insert(id.to_string(), path.to_string());
                        }
                    }
                }
                if let Some(threads) = r_host.get("threads").and_then(Value::as_array) {
                    for t in threads {
                        let Some(tid) = t.get("id").and_then(Value::as_str) else {
                            continue;
                        };
                        let pid = t.get("projectId").and_then(Value::as_str).unwrap_or("");
                        let pfolder = proj_map.get(pid).cloned().unwrap_or_default();
                        let wd = t
                            .get("workingDirectory")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(ToString::to_string)
                            .unwrap_or_else(|| pfolder.clone());
                        if !wd.is_empty() {
                            hosted.insert(
                                host_entity_key(Some(hid), tid),
                                HostThreadFoldersEntry {
                                    host_id: hid.clone(),
                                    project_id: host_entity_key(Some(hid), pid),
                                    working_directory: wd,
                                    project_folder: pfolder,
                                },
                            );
                        }
                    }
                }
            }
        }
        let hosted_delta = self.files_tracker.sync_hosted(&hosted, &terminals);
        match (combined, hosted_delta) {
            (None, h) => h,
            (l, None) => l,
            (Some(mut l), Some(h)) => {
                l.hosted_folders = h.hosted_folders;
                l.terminal_hosts = h.terminal_hosts;
                Some(l)
            }
        }
    }

    pub fn files_bindings_snapshot(&self) -> FilesBindingsDelta {
        self.files_tracker.snapshot()
    }

    pub fn close(&mut self) {
        for (_, reg) in self.remotes.drain() {
            reg.client.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unkey_and_project_host_entity_keys_accurately() {
        let hid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let thread = json!({
            "id": "t-1",
            "projectId": "p-1",
            "delegatedBy": "t-0",
            "title": "Remote work"
        });
        let projected = key_thread_value(&thread, hid, "Forge", true);
        assert_eq!(projected["id"], format!("host:{hid}:t-1"));
        assert_eq!(projected["projectId"], format!("host:{hid}:p-1"));
        assert_eq!(projected["delegatedBy"], format!("host:{hid}:t-0"));
        assert_eq!(projected["remoteHost"], true);
        assert_eq!(projected["hostLabel"], "Forge");

        let mut cmd = Map::new();
        cmd.insert("type".into(), json!("manual-send"));
        cmd.insert("threadId".into(), json!(format!("host:{hid}:t-1")));
        cmd.insert("projectId".into(), json!(format!("host:{hid}:p-1")));
        cmd.insert("hostId".into(), json!(hid));
        let unkeyed = unkey_command_for_host(&cmd, hid);
        assert_eq!(unkeyed["threadId"], "t-1");
        assert_eq!(unkeyed["projectId"], "p-1");
        assert!(!unkeyed.contains_key("hostId"));
    }

    #[test]
    fn parse_http_url_handles_ipv4_ipv6_and_rejects_non_http() {
        assert_eq!(
            parse_http_url("http://127.0.0.1:10000").unwrap(),
            ("127.0.0.1".into(), 10000)
        );
        assert_eq!(
            parse_http_url("http://[::1]:4567/v1").unwrap(),
            ("::1".into(), 4567)
        );
        assert!(parse_http_url("https://example.com").is_err());
    }
}
