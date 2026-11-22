mod server;
mod ws;

use std::path::PathBuf;
use std::process::ExitCode;

use sotto_core::{
    acquire_host_lock, load_host_identity, read_boot_id, release_host_lock, HostLease,
};

use crate::server::RunningServer;

#[derive(Debug)]
struct HostCliArgs {
    data_directory: PathBuf,
    port: u16,
    _key_file: Option<PathBuf>,
    started_by: Option<String>,
}

fn parse_args(args: &[String]) -> Result<HostCliArgs, String> {
    let mut data_directory = std::env::var("SOTTO_HOST_DATA").ok().map(PathBuf::from);
    let mut key_file = std::env::var("SOTTO_HOST_KEY_FILE").ok().map(PathBuf::from);
    let mut port: u16 = 0;

    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        if flag != "--data" && flag != "--port" && flag != "--key-file" {
            return Err("Use --data <folder> and optionally --key-file <file>.".into());
        }
        i += 1;
        let Some(value) = args.get(i) else {
            return Err("Each host option needs a value.".into());
        };
        if value.is_empty() || value.starts_with("--") {
            return Err("Each host option needs a value.".into());
        }
        match flag {
            "--data" => data_directory = Some(PathBuf::from(value)),
            "--key-file" => key_file = Some(PathBuf::from(value)),
            "--port" => {
                port = value
                    .parse::<u16>()
                    .map_err(|_| "Choose a port from 0 through 65535.".to_string())?;
            }
            _ => unreachable!(),
        }
        i += 1;
    }

    let Some(data_directory) = data_directory.filter(|p| !p.as_os_str().is_empty()) else {
        return Err("Choose a host data folder with --data or SOTTO_HOST_DATA.".into());
    };

    let started_by = std::env::var("SOTTO_HOST_STARTED_BY")
        .ok()
        .filter(|v| v == "ssh" || v == "boot");

    Ok(HostCliArgs {
        data_directory,
        port,
        _key_file: key_file,
        started_by,
    })
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).ok();
        let ctrl_c = tokio::signal::ctrl_c();
        match term.as_mut() {
            Some(term_stream) => {
                tokio::select! {
                    _ = ctrl_c => {}
                    _ = term_stream.recv() => {}
                }
            }
            None => {
                let _ = ctrl_c.await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let parsed = match parse_args(&raw_args) {
        Ok(args) => args,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(1);
        }
    };

    if let Err(err) = std::fs::create_dir_all(&parsed.data_directory) {
        eprintln!("Could not create host data folder: {err}");
        return ExitCode::from(1);
    }

    let boot = read_boot_id();
    let lease = HostLease::current(boot.clone());
    let lock_path = parsed.data_directory.join("host-listener.lock");
    if let Err(err) = acquire_host_lock(&lock_path, &lease, boot.as_deref()) {
        eprintln!("{err}");
        return ExitCode::from(err.exit_code() as u8);
    }

    let host_id = match load_host_identity(&parsed.data_directory) {
        Ok(id) => id,
        Err(err) => {
            eprintln!("{err}");
            let _ = release_host_lock(&lock_path, &lease);
            return ExitCode::from(1);
        }
    };

    let server = match RunningServer::start(
        parsed.data_directory.clone(),
        host_id,
        parsed.port,
        parsed.started_by,
    )
    .await
    {
        Ok(srv) => srv,
        Err(err) => {
            eprintln!("Could not start host listener: {err}");
            let _ = release_host_lock(&lock_path, &lease);
            return ExitCode::from(1);
        }
    };

    wait_for_shutdown_signal().await;
    server.close().await;
    let _ = release_host_lock(&lock_path, &lease);
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpStream;

    async fn http_request(
        port: u16,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        body: Option<&str>,
    ) -> (u16, serde_json::Value) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let body_bytes = body.unwrap_or("").as_bytes();
        let mut req = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\n",
            body_bytes.len()
        );
        if let Some(tok) = bearer {
            req.push_str(&format!("Authorization: Bearer {tok}\r\n"));
        }
        if !body_bytes.is_empty() {
            req.push_str("Content-Type: application/json\r\n");
        }
        req.push_str("Connection: close\r\n\r\n");
        stream.write_all(req.as_bytes()).await.unwrap();
        stream.write_all(body_bytes).await.unwrap();

        let mut reader = BufReader::new(stream);
        let mut status_line = String::new();
        reader.read_line(&mut status_line).await.unwrap();
        let status: u16 = status_line
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let mut content_len = 0usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            if line == "\r\n" || line == "\n" || line.is_empty() {
                break;
            }
            if let Some((k, v)) = line.split_once(':') {
                if k.trim().eq_ignore_ascii_case("content-length") {
                    content_len = v.trim().parse().unwrap_or(0);
                }
            }
        }
        let mut buf = vec![0u8; content_len];
        reader.read_exact(&mut buf).await.unwrap();
        (status, serde_json::from_slice(&buf).unwrap())
    }

    #[tokio::test]
    async fn health_pair_session_and_websocket_protocol_v1_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let host_id = load_host_identity(dir.path()).unwrap();
        let srv = RunningServer::start(dir.path().to_path_buf(), host_id.clone(), 0, None)
            .await
            .unwrap();
        let port = srv.state.port;
        let admin_token = srv.state.admin_token.clone();

        // /v1/health
        let (status, health) = http_request(port, "GET", "/v1/health", None, None).await;
        assert_eq!(status, 200);
        assert_eq!(health["hostId"], host_id);
        assert_eq!(health["runtime"], "rust");
        assert_eq!(health["status"], "ready");

        // Admin endpoint rejects missing/wrong bearer
        let (status, _) =
            http_request(port, "POST", "/v1/admin/pairing-code", Some("wrong"), None).await;
        assert_eq!(status, 401);

        // Issue pairing code -> redeem -> mint session
        let (status, issued) = http_request(
            port,
            "POST",
            "/v1/admin/pairing-code",
            Some(&admin_token),
            None,
        )
        .await;
        assert_eq!(status, 200);
        let code = issued["code"].as_str().unwrap();

        let pair_body = serde_json::json!({ "v": 1, "code": code, "name": "Test Desktop" }).to_string();
        let (status, paired) =
            http_request(port, "POST", "/v1/pair", None, Some(&pair_body)).await;
        assert_eq!(status, 200);
        let token = paired["token"].as_str().unwrap();

        let (status, session_res) =
            http_request(port, "POST", "/v1/session", Some(token), None).await;
        assert_eq!(status, 200);
        let session = session_res["session"].as_str().unwrap();

        // Upgrade WebSocket with permessage-deflate and send `hello` + `ping`
        let mut ws = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let upgrade = format!(
            "GET /v1/socket HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: Bearer {session}\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Extensions: permessage-deflate; client_no_context_takeover; server_no_context_takeover\r\n\r\n"
        );
        ws.write_all(upgrade.as_bytes()).await.unwrap();
        let mut ws_reader = BufReader::new(ws);
        let mut resp_line = String::new();
        ws_reader.read_line(&mut resp_line).await.unwrap();
        assert!(resp_line.starts_with("HTTP/1.1 101"));
        let mut saw_accept = false;
        let mut saw_deflate = false;
        loop {
            let mut h = String::new();
            ws_reader.read_line(&mut h).await.unwrap();
            if h == "\r\n" || h == "\n" {
                break;
            }
            if h.to_ascii_lowercase().starts_with("sec-websocket-accept:") {
                assert!(h.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
                saw_accept = true;
            }
            if h.to_ascii_lowercase()
                .starts_with("sec-websocket-extensions:")
            {
                saw_deflate = h.contains("permessage-deflate");
            }
        }
        assert!(saw_accept && saw_deflate);

        // Send masked client `hello` frame
        let mut ws_stream = ws_reader.into_inner();
        let hello = r#"{"v":1,"id":"req-1","op":"hello"}"#;
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        let mut frame = vec![0x81, 0x80 | (hello.len() as u8)];
        frame.extend_from_slice(&mask);
        for (idx, b) in hello.as_bytes().iter().enumerate() {
            frame.push(b ^ mask[idx & 3]);
        }
        ws_stream.write_all(&frame).await.unwrap();
        ws_stream.flush().await.unwrap();

        // Read unmasked server response frame
        let mut hdr = [0u8; 2];
        ws_stream.read_exact(&mut hdr).await.unwrap();
        assert_eq!(hdr[0] & 0x0f, 0x1);
        let len_b = hdr[1] & 0x7f;
        let len = if len_b == 126 {
            let mut ext = [0u8; 2];
            ws_stream.read_exact(&mut ext).await.unwrap();
            u16::from_be_bytes(ext) as usize
        } else {
            len_b as usize
        };
        let mut resp_payload = vec![0u8; len];
        ws_stream.read_exact(&mut resp_payload).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&resp_payload).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["id"], "req-1");
        assert_eq!(parsed["result"]["hostId"], host_id);
        assert_eq!(parsed["result"]["runtime"], "rust");

        // Revoking the paired client immediately closes the already-open WebSocket.
        let revoke_body = serde_json::json!({ "clientId": paired["clientId"] }).to_string();
        let (status, revoked) = http_request(
            port,
            "POST",
            "/v1/admin/revoke-client",
            Some(&admin_token),
            Some(&revoke_body),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(revoked["revoked"], true);

        let mut close_hdr = [0u8; 2];
        let read_res = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            ws_stream.read_exact(&mut close_hdr),
        )
        .await
        .unwrap();
        match read_res {
            Ok(_) => assert_eq!(close_hdr[0] & 0x0f, 0x8),
            Err(err) => assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof),
        }

        // Oversized HTTP header line is rejected without unbounded buffering.
        let mut big = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let huge = format!("GET /v1/health HTTP/1.1\r\nX-Pad: {}\r\n\r\n", "a".repeat(20_000));
        let _ = big.write_all(huge.as_bytes()).await;
        let mut big_reader = BufReader::new(big);
        let mut status_line = String::new();
        big_reader.read_line(&mut status_line).await.unwrap();
        assert!(status_line.starts_with("HTTP/1.1 413"));

        srv.close().await;
        assert!(!dir.path().join("host-listener.json").exists());
    }
}
