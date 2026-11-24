// Full Phase 2 `EngineTransport` wire helpers (ADR-0210), including streaming `res-chunk` binary
// framing used by media/plugin services in subsequent Phase 4b slices.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

/// Maximum single `EngineTransport` frame size (64 MiB, matching `MAX_ENGINE_FRAME_BYTES` in `transport.ts`).
pub const MAX_ENGINE_FRAME_BYTES: usize = 64 * 1024 * 1024;
/// Raw byte chunk size for streaming large binary responses (16 MiB, matching `DEFAULT_BINARY_CHUNK_BYTES`).
pub const DEFAULT_BINARY_CHUNK_BYTES: usize = 16 * 1024 * 1024;
/// Maximum reassembled binary response size (256 MiB, matching `MAX_CHUNKED_RESPONSE_BYTES`).
pub const MAX_CHUNKED_RESPONSE_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum IncomingEngineMessage {
    Req {
        id: u64,
        method: String,
        #[serde(default)]
        args: Vec<Value>,
    },
    Res {
        id: u64,
        ok: bool,
        #[serde(default)]
        value: Value,
        #[serde(default)]
        error: Option<SerializedEngineError>,
    },
    ResChunk {
        id: u64,
        index: usize,
        total: usize,
        b64: String,
    },
    Push {
        event: String,
        #[serde(default)]
        payload: Value,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SerializedEngineError {
    pub name: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl SerializedEngineError {
    pub fn new(message: impl Into<String>, code: Option<&str>) -> Self {
        Self {
            name: "Error".into(),
            message: message.into(),
            code: code.map(ToString::to_string),
        }
    }
}

/// Boxes raw bytes into Phase 2 `EngineTransport`'s `{ "__sottoBin": 1, "b64": "..." }` JSON representation.
pub fn box_binary(bytes: &[u8]) -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("__sottoBin".into(), Value::Number(1u64.into()));
    map.insert("b64".into(), Value::String(STANDARD.encode(bytes)));
    Value::Object(map)
}

/// Returns `true` when `value` is a boxed binary object (`{ "__sottoBin": 1, "b64": "..." }`).
pub fn is_binary_box(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    obj.get("__sottoBin").and_then(Value::as_u64) == Some(1)
        && obj.get("b64").and_then(Value::as_str).is_some()
}

/// Decodes a boxed binary JSON object back into raw bytes.
pub fn unbox_binary(value: &Value) -> Option<Vec<u8>> {
    let obj = value.as_object()?;
    if obj.get("__sottoBin").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let b64 = obj.get("b64").and_then(Value::as_str)?;
    STANDARD.decode(b64).ok()
}

/// Encodes a JSON value into ADR-0210's 4-byte big-endian length-prefixed binary frame.
pub fn encode_engine_frame(value: &Value) -> io::Result<Vec<u8>> {
    let body = serde_json::to_vec(value).map_err(io::Error::other)?;
    if body.len() > MAX_ENGINE_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ENGINE_FRAME_TOO_LARGE",
        ));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// Writes a single length-prefixed JSON frame to the OS IPC stream.
pub async fn write_engine_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &Value,
) -> io::Result<()> {
    let frame = encode_engine_frame(value)?;
    writer.write_all(&frame).await?;
    writer.flush().await
}

/// Reads a single length-prefixed JSON frame from the OS IPC stream.
pub async fn read_engine_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> io::Result<Option<IncomingEngineMessage>> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err),
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_ENGINE_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ENGINE_FRAME_TOO_LARGE",
        ));
    }
    let mut body = Vec::with_capacity(len.min(64 * 1024));
    let read = reader.take(len as u64).read_to_end(&mut body).await?;
    if read != len {
        return Ok(None);
    }
    let parsed: IncomingEngineMessage = serde_json::from_slice(&body)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    Ok(Some(parsed))
}

pub fn hello_frame(token: &str) -> Value {
    json!({ "kind": "hello", "token": token })
}

pub fn req_frame(id: u64, method: &str, args: Vec<Value>) -> Value {
    json!({ "kind": "req", "id": id, "method": method, "args": args })
}

pub fn ok_response_frame(id: u64, value: Value) -> Value {
    json!({ "kind": "res", "id": id, "ok": true, "value": value })
}

pub fn err_response_frame(id: u64, error: SerializedEngineError) -> Value {
    json!({ "kind": "res", "id": id, "ok": false, "error": error })
}

pub fn res_chunk_frame(id: u64, index: usize, total: usize, chunk: &[u8]) -> Value {
    json!({
        "kind": "res-chunk",
        "id": id,
        "index": index,
        "total": total,
        "b64": STANDARD.encode(chunk),
    })
}

pub fn push_frame(event: &str, payload: Value) -> Value {
    json!({ "kind": "push", "event": event, "payload": payload })
}

/// Builds either a boxed `res` frame or a sequence of `res-chunk` frames when `bytes` exceeds `chunk_bytes`.
pub fn binary_response_frames(id: u64, bytes: &[u8], chunk_bytes: usize) -> Vec<Value> {
    let limit = chunk_bytes.max(1);
    if bytes.len() <= limit {
        return vec![ok_response_frame(id, box_binary(bytes))];
    }
    let total = bytes.len().div_ceil(limit);
    let mut out = Vec::with_capacity(total);
    for (index, slice) in bytes.chunks(limit).enumerate() {
        out.push(res_chunk_frame(id, index, total, slice));
    }
    out
}

/// Incoming event dispatched by [`EngineDuplex`] to the engine's main loop.
#[derive(Debug, Clone)]
pub enum IncomingEngineEvent {
    Req {
        id: u64,
        method: String,
        args: Vec<Value>,
    },
    Push {
        event: String,
        payload: Value,
    },
}

struct IncomingChunkState {
    total: usize,
    parts: Vec<Option<Vec<u8>>>,
    received: usize,
    total_bytes: usize,
}

type PendingSender = oneshot::Sender<Result<Value, SerializedEngineError>>;

struct DuplexState {
    pending: HashMap<u64, PendingSender>,
    chunks: HashMap<u64, IncomingChunkState>,
}

/// Full-duplex Phase 2 `EngineTransport` connection supporting simultaneous incoming RPCs/pushes
/// and outgoing reverse-RPC requests with binary chunk reassembly (`req`/`res`/`res-chunk`/`push`).
#[derive(Clone)]
pub struct EngineDuplex {
    out_tx: mpsc::UnboundedSender<Value>,
    state: Arc<Mutex<DuplexState>>,
    next_id: Arc<AtomicU64>,
    closed: Arc<AtomicBool>,
    binary_chunk_bytes: usize,
}

/// Lifecycle handles returned alongside [`EngineDuplex`] so the caller owns shutdown ordering.
pub struct EngineDuplexParts {
    pub duplex: EngineDuplex,
    pub incoming_rx: mpsc::Receiver<IncomingEngineEvent>,
    pub reader_task: tokio::task::JoinHandle<()>,
    pub writer_task: tokio::task::JoinHandle<()>,
}

impl EngineDuplex {
    /// Starts reader & writer tasks on an already-connected `AsyncRead + AsyncWrite` stream,
    /// immediately authenticating with `hello_frame(token)` when `token` is `Some`.
    pub async fn connect_stream<S>(stream: S, token: Option<&str>) -> io::Result<EngineDuplexParts>
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let (mut read_half, mut write_half) = tokio::io::split(stream);
        if let Some(tok) = token {
            write_engine_frame(&mut write_half, &hello_frame(tok)).await?;
        }

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
        let (in_tx, incoming_rx) = mpsc::channel::<IncomingEngineEvent>(128);
        let state = Arc::new(Mutex::new(DuplexState {
            pending: HashMap::new(),
            chunks: HashMap::new(),
        }));
        let closed = Arc::new(AtomicBool::new(false));

        let writer_closed = Arc::clone(&closed);
        let writer_state = Arc::clone(&state);
        let writer_task = tokio::spawn(async move {
            while let Some(frame) = out_rx.recv().await {
                if write_engine_frame(&mut write_half, &frame).await.is_err() {
                    break;
                }
            }
            writer_closed.store(true, Ordering::SeqCst);
            fail_all_pending(&writer_state, "Engine transport writer closed.");
        });

        let reader_closed = Arc::clone(&closed);
        let reader_state = Arc::clone(&state);
        let reader_task = tokio::spawn(async move {
            while let Ok(Some(msg)) = read_engine_frame(&mut read_half).await {
                match msg {
                    IncomingEngineMessage::Req { id, method, args } => {
                        if in_tx
                            .send(IncomingEngineEvent::Req { id, method, args })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    IncomingEngineMessage::Push { event, payload } => {
                        if in_tx
                            .send(IncomingEngineEvent::Push { event, payload })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    IncomingEngineMessage::Res {
                        id,
                        ok,
                        value,
                        error,
                    } => {
                        let sender = {
                            let mut guard = reader_state.lock().unwrap_or_else(|e| e.into_inner());
                            guard.chunks.remove(&id);
                            guard.pending.remove(&id)
                        };
                        if let Some(tx) = sender {
                            let outcome = if ok {
                                Ok(value)
                            } else {
                                Err(error.unwrap_or_else(|| {
                                    SerializedEngineError::new(
                                        "Reverse RPC failed.",
                                        Some("SHELL_ERROR"),
                                    )
                                }))
                            };
                            let _ = tx.send(outcome);
                        }
                    }
                    IncomingEngineMessage::ResChunk {
                        id,
                        index,
                        total,
                        b64,
                    } => {
                        handle_incoming_chunk(&reader_state, id, index, total, &b64);
                    }
                    IncomingEngineMessage::Other => {}
                }
            }
            reader_closed.store(true, Ordering::SeqCst);
            fail_all_pending(&reader_state, "Engine transport closed.");
        });

        Ok(EngineDuplexParts {
            duplex: Self {
                out_tx,
                state,
                next_id: Arc::new(AtomicU64::new(1)),
                closed,
                binary_chunk_bytes: DEFAULT_BINARY_CHUNK_BYTES,
            },
            incoming_rx,
            reader_task,
            writer_task,
        })
    }

    pub fn with_binary_chunk_bytes(mut self, bytes: usize) -> Self {
        self.binary_chunk_bytes = bytes.max(1);
        self
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn send_frame(&self, frame: Value) -> bool {
        if self.is_closed() {
            return false;
        }
        self.out_tx.send(frame).is_ok()
    }

    pub fn send_push(&self, event: &str, payload: Value) -> bool {
        self.send_frame(push_frame(event, payload))
    }

    pub fn send_ok(&self, id: u64, value: Value) -> bool {
        self.send_frame(ok_response_frame(id, value))
    }

    pub fn send_ok_binary(&self, id: u64, bytes: &[u8]) -> bool {
        for frame in binary_response_frames(id, bytes, self.binary_chunk_bytes) {
            if !self.send_frame(frame) {
                return false;
            }
        }
        true
    }

    pub fn send_err(&self, id: u64, error: SerializedEngineError) -> bool {
        self.send_frame(err_response_frame(id, error))
    }

    /// Sends a reverse-RPC request (`Engine → Shell`) and waits up to `timeout` for its response.
    pub async fn request(
        &self,
        method: &str,
        args: Vec<Value>,
        timeout: Duration,
    ) -> Result<Value, SerializedEngineError> {
        if self.is_closed() {
            return Err(SerializedEngineError::new(
                "Shell connection is closed.",
                Some("SHELL_UNAVAILABLE"),
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            guard.pending.insert(id, tx);
        }
        if self.out_tx.send(req_frame(id, method, args)).is_err() {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            guard.pending.remove(&id);
            return Err(SerializedEngineError::new(
                "Shell connection is closed.",
                Some("SHELL_UNAVAILABLE"),
            ));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(SerializedEngineError::new(
                "Shell connection closed before answering.",
                Some("SHELL_UNAVAILABLE"),
            )),
            Err(_) => {
                let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
                guard.pending.remove(&id);
                guard.chunks.remove(&id);
                Err(SerializedEngineError::new(
                    format!("SHELL_REQUEST_TIMEOUT: {method}"),
                    Some("TIMEOUT"),
                ))
            }
        }
    }
}

fn handle_incoming_chunk(
    state: &Arc<Mutex<DuplexState>>,
    id: u64,
    index: usize,
    total: usize,
    b64: &str,
) {
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    if !guard.pending.contains_key(&id) {
        return;
    }
    if total == 0 || index >= total {
        guard.chunks.remove(&id);
        if let Some(tx) = guard.pending.remove(&id) {
            let _ = tx.send(Err(SerializedEngineError::new(
                "ENGINE_INVALID_BINARY_CHUNK",
                Some("INVALID_CHUNK"),
            )));
        }
        return;
    }
    let Ok(bytes) = STANDARD.decode(b64) else {
        guard.chunks.remove(&id);
        if let Some(tx) = guard.pending.remove(&id) {
            let _ = tx.send(Err(SerializedEngineError::new(
                "ENGINE_INVALID_BINARY_CHUNK",
                Some("INVALID_CHUNK"),
            )));
        }
        return;
    };
    let chunk_state = guard
        .chunks
        .entry(id)
        .or_insert_with(|| IncomingChunkState {
            total,
            parts: vec![None; total],
            received: 0,
            total_bytes: 0,
        });
    if chunk_state.total != total {
        guard.chunks.remove(&id);
        if let Some(tx) = guard.pending.remove(&id) {
            let _ = tx.send(Err(SerializedEngineError::new(
                "ENGINE_INVALID_BINARY_CHUNK",
                Some("INVALID_CHUNK"),
            )));
        }
        return;
    }
    if chunk_state.parts[index].is_none() {
        chunk_state.total_bytes = chunk_state.total_bytes.saturating_add(bytes.len());
        chunk_state.parts[index] = Some(bytes);
        chunk_state.received += 1;
    }
    if chunk_state.total_bytes > MAX_CHUNKED_RESPONSE_BYTES {
        guard.chunks.remove(&id);
        if let Some(tx) = guard.pending.remove(&id) {
            let _ = tx.send(Err(SerializedEngineError::new(
                "ENGINE_FRAME_TOO_LARGE",
                Some("FRAME_TOO_LARGE"),
            )));
        }
        return;
    }
    if chunk_state.received == chunk_state.total {
        if let Some(finished) = guard.chunks.remove(&id) {
            let mut combined = Vec::with_capacity(finished.total_bytes);
            for part in finished.parts.into_iter().flatten() {
                combined.extend_from_slice(&part);
            }
            if let Some(tx) = guard.pending.remove(&id) {
                let _ = tx.send(Ok(box_binary(&combined)));
            }
        }
    }
}

fn fail_all_pending(state: &Arc<Mutex<DuplexState>>, message: &str) {
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.chunks.clear();
    for (_, tx) in guard.pending.drain() {
        let _ = tx.send(Err(SerializedEngineError::new(
            message,
            Some("SHELL_UNAVAILABLE"),
        )));
    }
}

/// Platform-native OS IPC stream connecting `sotto-engine` to Electron main's `listenEngineServer`.
#[cfg(windows)]
pub type EngineStream = tokio::net::windows::named_pipe::NamedPipeClient;

#[cfg(unix)]
pub type EngineStream = tokio::net::UnixStream;

/// Connects to the local `EngineTransport` endpoint (Windows named pipe or POSIX Unix socket),
/// retrying briefly while the shell's pipe/socket server completes startup.
pub async fn connect_engine_stream(endpoint: &str) -> io::Result<EngineStream> {
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        const ERROR_PIPE_BUSY: i32 = 231;
        const ERROR_FILE_NOT_FOUND: i32 = 2;
        let mut attempts = 0u32;
        loop {
            match ClientOptions::new().open(endpoint) {
                Ok(client) => return Ok(client),
                Err(err)
                    if matches!(
                        err.raw_os_error(),
                        Some(ERROR_PIPE_BUSY | ERROR_FILE_NOT_FOUND)
                    ) && attempts < 50 =>
                {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(err) => return Err(err),
            }
        }
    }

    #[cfg(unix)]
    {
        let mut attempts = 0u32;
        loop {
            match tokio::net::UnixStream::connect(endpoint).await {
                Ok(stream) => return Ok(stream),
                Err(err)
                    if matches!(
                        err.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                    ) && attempts < 50 =>
                {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(err) => return Err(err),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_length_prefixed_engine_frames() {
        let frame = encode_engine_frame(&hello_frame("abc123")).unwrap();
        let len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        assert_eq!(len, frame.len() - 4);
        let parsed: Value = serde_json::from_slice(&frame[4..]).unwrap();
        assert_eq!(parsed["kind"], "hello");
        assert_eq!(parsed["token"], "abc123");
    }

    #[test]
    fn boxes_and_unboxes_binary_values() {
        let payload = vec![0u8, 1, 2, 255, 128, 42];
        let boxed = box_binary(&payload);
        assert!(is_binary_box(&boxed));
        assert_eq!(unbox_binary(&boxed).as_deref(), Some(payload.as_slice()));
        assert!(!is_binary_box(&json!({ "not": "bin" })));
    }

    #[test]
    fn splits_large_binary_responses_into_res_chunks() {
        let data = vec![0xABu8; 25];
        let small = binary_response_frames(7, &data, 32);
        assert_eq!(small.len(), 1);
        assert_eq!(small[0]["kind"], "res");
        assert_eq!(unbox_binary(&small[0]["value"]).as_deref(), Some(data.as_slice()));

        let chunked = binary_response_frames(9, &data, 10);
        assert_eq!(chunked.len(), 3);
        for (i, frame) in chunked.iter().enumerate() {
            assert_eq!(frame["kind"], "res-chunk");
            assert_eq!(frame["id"], 9);
            assert_eq!(frame["index"], i);
            assert_eq!(frame["total"], 3);
        }
    }

    #[tokio::test]
    async fn supports_full_duplex_reverse_rpc_chunk_reassembly_and_pushes() {
        let (engine_side, shell_side) = tokio::io::duplex(64 * 1024);
        let (mut shell_read, mut shell_write) = tokio::io::split(shell_side);

        let mut parts = EngineDuplex::connect_stream(engine_side, Some("secret-tok"))
            .await
            .unwrap();

        // Shell reads hello frame first.
        let mut len_buf = [0u8; 4];
        shell_read.read_exact(&mut len_buf).await.unwrap();
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut hello_bytes = vec![0u8; len];
        shell_read.read_exact(&mut hello_bytes).await.unwrap();
        let hello: Value = serde_json::from_slice(&hello_bytes).unwrap();
        assert_eq!(hello["kind"], "hello");
        assert_eq!(hello["token"], "secret-tok");

        // Shell sends a push to engine.
        write_engine_frame(
            &mut shell_write,
            &push_frame("engine:setWindowFocus", json!({ "focused": true })),
        )
        .await
        .unwrap();
        match parts.incoming_rx.recv().await {
            Some(IncomingEngineEvent::Push { event, payload }) => {
                assert_eq!(event, "engine:setWindowFocus");
                assert_eq!(payload["focused"], true);
            }
            other => panic!("expected push, got {other:?}"),
        }

        // Engine issues a reverse-RPC request and shell answers with multi-chunk `res-chunk`.
        let duplex = parts.duplex.clone();
        let req_task = tokio::spawn(async move {
            duplex
                .request(
                    "shell:redrawPhoto",
                    vec![box_binary(b"input"), json!("image/png")],
                    Duration::from_secs(5),
                )
                .await
        });

        let shell_msg = read_engine_frame(&mut shell_read).await.unwrap().unwrap();
        let req_id = match shell_msg {
            IncomingEngineMessage::Req { id, method, args } => {
                assert_eq!(method, "shell:redrawPhoto");
                assert_eq!(unbox_binary(&args[0]).as_deref(), Some(b"input".as_slice()));
                id
            }
            other => panic!("expected req, got {other:?}"),
        };

        // Send chunks out of order to verify index-based reassembly.
        write_engine_frame(&mut shell_write, &res_chunk_frame(req_id, 1, 2, b"world"))
            .await
            .unwrap();
        write_engine_frame(&mut shell_write, &res_chunk_frame(req_id, 0, 2, b"hello "))
            .await
            .unwrap();

        let answer = req_task.await.unwrap().unwrap();
        assert_eq!(
            unbox_binary(&answer).as_deref(),
            Some(b"hello world".as_slice())
        );

        parts.reader_task.abort();
        parts.writer_task.abort();
    }
}
