use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};
use sha1::{Digest, Sha1};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use sotto_core::HOST_MAX_FRAME_BYTES;

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
pub const DEFLATE_RESPONSE: &str =
    "permessage-deflate; server_no_context_takeover; client_no_context_takeover";
const DEFLATE_MIN_BYTES: usize = 1024;
const DEFLATE_TAIL: [u8; 4] = [0x00, 0x00, 0xff, 0xff];

#[derive(Debug, Error)]
pub enum WsError {
    #[error("WebSocket frame exceeds limit")]
    TooLarge,
    #[error("Protocol error: {0}")]
    Protocol(&'static str),
    #[error("Invalid UTF-8 in text frame")]
    Utf8(#[from] std::string::FromUtf8Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, PartialEq, Eq)]
pub enum WsMessage {
    Text(String),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    Close,
}

/// Computes RFC 6455 `Sec-WebSocket-Accept` for a validated `Sec-WebSocket-Key`.
pub fn websocket_accept(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(WS_GUID.as_bytes());
    STANDARD.encode(hasher.finalize())
}

/// Validates RFC 6455 `Sec-WebSocket-Key` (16 random bytes base64-encoded: 22 chars + `==`).
pub fn is_valid_websocket_key(key: &str) -> bool {
    key.len() == 24
        && key.ends_with("==")
        && key[..22]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// Checks whether `Sec-WebSocket-Extensions` offers a compatible `permessage-deflate` mode
/// (matching `deflateOffered` in `src/host/socketFrames.ts`).
pub fn deflate_offered(header: Option<&str>) -> bool {
    let Some(header) = header else {
        return false;
    };
    header.split(',').any(|offer| {
        let mut parts = offer.split(';').map(str::trim).filter(|s| !s.is_empty());
        let Some(name) = parts.next() else {
            return false;
        };
        if !name.eq_ignore_ascii_case("permessage-deflate") {
            return false;
        }
        let mut seen = Vec::new();
        for param in parts {
            let (key, val) = match param.split_once('=') {
                Some((k, v)) => (k.trim().to_ascii_lowercase(), Some(v.trim().trim_matches('"'))),
                None => (param.to_ascii_lowercase(), None),
            };
            if seen.contains(&key) {
                return false;
            }
            seen.push(key.clone());
            let valid = match (key.as_str(), val) {
                ("server_no_context_takeover" | "client_no_context_takeover", None) => true,
                ("client_max_window_bits", None) => true,
                ("client_max_window_bits", Some(v)) => {
                    matches!(v.parse::<u8>(), Ok(8..=15))
                }
                ("server_max_window_bits", Some("15")) => true,
                _ => false,
            };
            if !valid {
                return false;
            }
        }
        true
    })
}

/// Reads the next complete client-masked WebSocket message from `stream`.
pub async fn read_ws_message<S: AsyncRead + Unpin>(
    stream: &mut S,
    deflate: bool,
) -> Result<WsMessage, WsError> {
    let mut fragmented_opcode: Option<u8> = None;
    let mut fragmented_compressed = false;
    let mut accumulated: Vec<u8> = Vec::new();

    loop {
        let mut header = [0u8; 2];
        if let Err(err) = stream.read_exact(&mut header).await {
            if err.kind() == std::io::ErrorKind::UnexpectedEof {
                return Ok(WsMessage::Close);
            }
            return Err(WsError::Io(err));
        }

        let fin = (header[0] & 0x80) != 0;
        let rsv1 = (header[0] & 0x40) != 0;
        let rsv23 = (header[0] & 0x30) != 0;
        let opcode = header[0] & 0x0f;
        let masked = (header[1] & 0x80) != 0;
        let len_byte = header[1] & 0x7f;

        if rsv23 || (rsv1 && !deflate) {
            return Err(WsError::Protocol("unexpected reserved bits"));
        }
        if !masked {
            return Err(WsError::Protocol("client frame must be masked"));
        }

        let payload_len: usize = match len_byte {
            0..=125 => len_byte as usize,
            126 => {
                let mut ext = [0u8; 2];
                stream.read_exact(&mut ext).await?;
                u16::from_be_bytes(ext) as usize
            }
            127 => {
                let mut ext = [0u8; 8];
                stream.read_exact(&mut ext).await?;
                let len = u64::from_be_bytes(ext);
                usize::try_from(len).map_err(|_| WsError::TooLarge)?
            }
            _ => unreachable!(),
        };

        if payload_len > HOST_MAX_FRAME_BYTES || accumulated.len() + payload_len > HOST_MAX_FRAME_BYTES {
            return Err(WsError::TooLarge);
        }

        let mut mask = [0u8; 4];
        stream.read_exact(&mut mask).await?;
        let mut payload = vec![0u8; payload_len];
        stream.read_exact(&mut payload).await?;
        for (idx, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[idx & 3];
        }

        match opcode {
            0x8 => return Ok(WsMessage::Close),
            0x9 => return Ok(WsMessage::Ping(payload)),
            0xa => return Ok(WsMessage::Pong(payload)),
            0x1 | 0x2 => {
                if fragmented_opcode.is_some() {
                    return Err(WsError::Protocol("nested data frame during fragmentation"));
                }
                if fin {
                    let bytes = if rsv1 {
                        inflate_message(&payload)?
                    } else {
                        payload
                    };
                    if opcode == 0x1 {
                        return Ok(WsMessage::Text(String::from_utf8(bytes)?));
                    }
                    return Err(WsError::Protocol("binary frames are not supported in v1"));
                }
                fragmented_opcode = Some(opcode);
                fragmented_compressed = rsv1;
                accumulated = payload;
            }
            0x0 => {
                let Some(op) = fragmented_opcode else {
                    return Err(WsError::Protocol("unexpected continuation frame"));
                };
                if rsv1 {
                    return Err(WsError::Protocol("rsv1 set on continuation frame"));
                }
                accumulated.extend_from_slice(&payload);
                if fin {
                    let bytes = if fragmented_compressed {
                        inflate_message(&accumulated)?
                    } else {
                        accumulated
                    };
                    if op == 0x1 {
                        return Ok(WsMessage::Text(String::from_utf8(bytes)?));
                    }
                    return Err(WsError::Protocol("binary frames are not supported in v1"));
                }
            }
            _ => return Err(WsError::Protocol("unsupported opcode")),
        }
    }
}

/// Writes an unmasked server-to-client WebSocket text frame (compressing via RFC 7692 when active).
pub async fn write_ws_text<S: AsyncWrite + Unpin>(
    stream: &mut S,
    text: &str,
    deflate: bool,
) -> Result<(), WsError> {
    let raw = text.as_bytes();
    if raw.len() > HOST_MAX_FRAME_BYTES {
        return Err(WsError::TooLarge);
    }
    let (rsv1, payload) = if deflate && raw.len() >= DEFLATE_MIN_BYTES {
        (true, deflate_message(raw)?)
    } else {
        (false, raw.to_vec())
    };
    write_ws_frame(stream, 0x1, rsv1, &payload).await
}

pub async fn write_ws_pong<S: AsyncWrite + Unpin>(
    stream: &mut S,
    payload: &[u8],
) -> Result<(), WsError> {
    write_ws_frame(stream, 0xa, false, payload).await
}

pub async fn write_ws_close<S: AsyncWrite + Unpin>(stream: &mut S) -> Result<(), WsError> {
    write_ws_frame(stream, 0x8, false, &[]).await
}

async fn write_ws_frame<S: AsyncWrite + Unpin>(
    stream: &mut S,
    opcode: u8,
    rsv1: bool,
    payload: &[u8],
) -> Result<(), WsError> {
    let mut header = Vec::with_capacity(10);
    let first = 0x80 | if rsv1 { 0x40 } else { 0 } | (opcode & 0x0f);
    header.push(first);
    let len = payload.len();
    if len <= 125 {
        header.push(len as u8);
    } else if len <= 65535 {
        header.push(126);
        header.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(len as u64).to_be_bytes());
    }
    stream.write_all(&header).await?;
    stream.write_all(payload).await?;
    stream.flush().await?;
    Ok(())
}

fn deflate_message(input: &[u8]) -> Result<Vec<u8>, WsError> {
    // RFC 7692 section 7.2.1: raw deflate with Z_SYNC_FLUSH and drop trailing 0x00 0x00 0xff 0xff.
    let mut compressor = Compress::new(Compression::default(), false);
    let mut out = Vec::with_capacity(input.len() + 64);
    let mut consumed = 0usize;
    loop {
        if out.len() == out.capacity() {
            out.reserve(out.capacity().max(64));
        }
        let before_in = compressor.total_in();
        let before_out = compressor.total_out();
        let status = compressor
            .compress_vec(&input[consumed..], &mut out, FlushCompress::Sync)
            .map_err(|err| WsError::Io(std::io::Error::other(err.to_string())))?;
        consumed += (compressor.total_in() - before_in) as usize;
        let produced = (compressor.total_out() - before_out) as usize;
        if consumed >= input.len() && produced == 0 && status != Status::BufError {
            break;
        }
        if consumed >= input.len() && out.ends_with(&DEFLATE_TAIL) {
            break;
        }
    }
    if out.ends_with(&DEFLATE_TAIL) {
        out.truncate(out.len() - DEFLATE_TAIL.len());
    }
    Ok(out)
}

fn inflate_message(input: &[u8]) -> Result<Vec<u8>, WsError> {
    let mut with_tail = Vec::with_capacity(input.len() + DEFLATE_TAIL.len());
    with_tail.extend_from_slice(input);
    with_tail.extend_from_slice(&DEFLATE_TAIL);

    let mut decompressor = Decompress::new(false);
    let mut out = Vec::with_capacity(input.len().saturating_mul(2).max(256));
    let mut consumed = 0usize;
    loop {
        if out.len() > HOST_MAX_FRAME_BYTES {
            return Err(WsError::TooLarge);
        }
        if out.len() == out.capacity() {
            out.reserve(out.capacity().clamp(256, 64 * 1024));
        }
        let before_in = decompressor.total_in();
        let before_out = decompressor.total_out();
        let status = decompressor
            .decompress_vec(&with_tail[consumed..], &mut out, FlushDecompress::Sync)
            .map_err(|err| WsError::Io(std::io::Error::other(err.to_string())))?;
        consumed += (decompressor.total_in() - before_in) as usize;
        let produced = (decompressor.total_out() - before_out) as usize;
        if out.len() > HOST_MAX_FRAME_BYTES {
            return Err(WsError::TooLarge);
        }
        match status {
            Status::StreamEnd => break,
            Status::Ok | Status::BufError => {
                if consumed >= with_tail.len() && produced == 0 {
                    break;
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_rfc6455_accept_vector() {
        // RFC 6455 section 1.3 example vector.
        assert_eq!(
            websocket_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
        assert!(is_valid_websocket_key("dGhlIHNhbXBsZSBub25jZQ=="));
        assert!(!is_valid_websocket_key("short"));
    }

    #[test]
    fn negotiates_permessage_deflate_like_ts_host() {
        assert!(deflate_offered(Some(
            "permessage-deflate; client_no_context_takeover; server_no_context_takeover"
        )));
        assert!(deflate_offered(Some("permessage-deflate; client_max_window_bits")));
        assert!(!deflate_offered(Some("permessage-deflate; server_max_window_bits=12")));
        assert!(!deflate_offered(None));
    }

    #[test]
    fn round_trips_raw_deflate_with_rfc7692_tail_stripping() {
        let input = "hello sotto protocol v1 ".repeat(120);
        let compressed = deflate_message(input.as_bytes()).unwrap();
        assert!(compressed.len() < input.len());
        let restored = inflate_message(&compressed).unwrap();
        assert_eq!(restored, input.as_bytes());
    }
}
