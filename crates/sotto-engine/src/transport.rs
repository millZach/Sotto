use std::io;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Maximum single `EngineTransport` frame size (64 MiB, matching `MAX_ENGINE_FRAME_BYTES` in `transport.ts`).
pub const MAX_ENGINE_FRAME_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum IncomingEngineMessage {
    Req {
        id: u64,
        method: String,
        #[serde(default)]
        args: Vec<Value>,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Serialize)]
pub struct SerializedEngineError {
    pub name: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
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

pub fn ok_response_frame(id: u64, value: Value) -> Value {
    json!({ "kind": "res", "id": id, "ok": true, "value": value })
}

pub fn err_response_frame(id: u64, error: SerializedEngineError) -> Value {
    json!({ "kind": "res", "id": id, "ok": false, "error": error })
}

pub fn push_frame(event: &str, payload: Value) -> Value {
    json!({ "kind": "push", "event": event, "payload": payload })
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
                    if matches!(err.raw_os_error(), Some(ERROR_PIPE_BUSY | ERROR_FILE_NOT_FOUND))
                        && attempts < 50 =>
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
}
