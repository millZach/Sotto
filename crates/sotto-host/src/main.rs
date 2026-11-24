mod phones;
mod server;
mod wire_codec;
mod ws;

use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use sotto_core::{
    acquire_host_lock, load_host_identity, read_boot_id, release_host_lock, AcpAdapter,
    AcpAdapterConfig, AcpFlavor, ClaudeAdapter, ClaudeAdapterConfig, CodexAdapter,
    CodexAdapterConfig, HostCredentials, HostLease, MockProviderAdapter, MuseAdapter,
    MuseAdapterConfig, OpenCodeAdapter, OpenCodeAdapterConfig, ProviderAdapter,
};

use crate::server::{RunningServer, ServerConfig, DEFAULT_SOTTO_VERSION};

const REFEREE_OWL_VERSION: &str = "0.1.44-owl.20261118.2";

#[derive(Debug)]
struct HostCliArgs {
    data_directory: PathBuf,
    port: u16,
    key_file: Option<PathBuf>,
    sotto_version: String,
    mock_provider: Option<String>,
    fake_provider: Option<String>,
    fixtures_dir: Option<PathBuf>,
    started_by: Option<String>,
    enable_providers: bool,
}

fn parse_args(args: &[String]) -> Result<HostCliArgs, String> {
    let mut data_directory = std::env::var("SOTTO_HOST_DATA")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    let mut key_file = std::env::var("SOTTO_HOST_KEY_FILE")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    let mut explicit_version = std::env::var("SOTTO_HOST_VERSION")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let mut mock_provider = None;
    let mut fake_provider = None;
    let mut fixtures_dir = None;
    let mut port: u16 = 0;

    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        if flag != "--data"
            && flag != "--port"
            && flag != "--key-file"
            && flag != "--sotto-version"
            && flag != "--mock-provider"
            && flag != "--fake"
            && flag != "--fixtures-dir"
        {
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
            "--sotto-version" => explicit_version = Some(value.clone()),
            "--mock-provider" => mock_provider = Some(value.clone()),
            "--fake" => fake_provider = Some(value.clone()),
            "--fixtures-dir" => fixtures_dir = Some(PathBuf::from(value)),
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

    let sotto_version = explicit_version.unwrap_or_else(|| {
        if fake_provider.is_some() {
            REFEREE_OWL_VERSION.to_string()
        } else {
            DEFAULT_SOTTO_VERSION.to_string()
        }
    });

    let started_by = std::env::var("SOTTO_HOST_STARTED_BY")
        .ok()
        .filter(|v| v == "launch-script" || v == "boot");
    let enable_providers = std::env::var("SOTTO_HOST_ENABLE_PROVIDERS").as_deref() == Ok("1");

    Ok(HostCliArgs {
        data_directory,
        port,
        key_file,
        sotto_version,
        mock_provider,
        fake_provider,
        fixtures_dir,
        started_by,
        enable_providers,
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

fn main() -> ExitCode {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    if raw_args.iter().any(|arg| arg == "--version") {
        let payload = serde_json::json!({
            "runtime": "rust",
            "version": DEFAULT_SOTTO_VERSION,
        });
        println!("{payload}");
        return ExitCode::SUCCESS;
    }
    let parsed = match parse_args(&raw_args) {
        Ok(args) => args,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(1);
        }
    };
    // Clear launch-ownership and provider-enable markers before starting worker threads or
    // spawning provider child processes (matching `src/host/index.ts`).
    std::env::remove_var("SOTTO_HOST_STARTED_BY");
    std::env::remove_var("SOTTO_HOST_ENABLE_PROVIDERS");

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("Could not start async runtime: {err}");
            return ExitCode::from(1);
        }
    };
    runtime.block_on(run_host(parsed))
}

async fn run_host(parsed: HostCliArgs) -> ExitCode {

    if let Err(err) = std::fs::create_dir_all(&parsed.data_directory) {
        eprintln!("Could not create host data folder: {err}");
        return ExitCode::from(1);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            &parsed.data_directory,
            std::fs::Permissions::from_mode(0o700),
        );
    }

    let credentials =
        match HostCredentials::open(&parsed.data_directory, parsed.key_file.as_deref()) {
            Ok(creds) => creds,
            Err(err) => {
                eprintln!("{err}");
                return ExitCode::from(1);
            }
        };

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

    let mut providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
    if let Some(ref mock_id) = parsed.mock_provider {
        providers.insert(mock_id.clone(), Arc::new(MockProviderAdapter::new(mock_id)));
    }
    if let Some(ref fake_id) = parsed.fake_provider {
        let fixtures = parsed
            .fixtures_dir
            .clone()
            .unwrap_or_else(|| PathBuf::from("tests/fixtures"));
        match fake_id.as_str() {
            "codex" => {
                let script = fixtures.join("fakeCodexAppServer.mjs");
                providers.insert(
                    "codex".into(),
                    Arc::new(CodexAdapter::new(CodexAdapterConfig::fake(
                        parsed.data_directory.clone(),
                        script,
                    ))),
                );
            }
            "claude" => {
                let script = fixtures.join("fakeClaudeThread.mjs");
                providers.insert(
                    "claude".into(),
                    Arc::new(ClaudeAdapter::new(ClaudeAdapterConfig::fake(
                        parsed.data_directory.clone(),
                        script,
                    ))),
                );
            }
            "grok" => {
                let script = fixtures.join("fakeGrokThreadAgent.mjs");
                providers.insert(
                    "grok".into(),
                    Arc::new(AcpAdapter::new(AcpAdapterConfig::fake(
                        AcpFlavor::Grok,
                        parsed.data_directory.clone(),
                        script,
                    ))),
                );
            }
            "devin" => {
                let script = fixtures.join("fakeDevinAgent.mjs");
                providers.insert(
                    "devin".into(),
                    Arc::new(AcpAdapter::new(AcpAdapterConfig::fake(
                        AcpFlavor::Devin,
                        parsed.data_directory.clone(),
                        script,
                    ))),
                );
            }
            "muse" => {
                let script = fixtures.join("fakeMuseAgent.mjs");
                providers.insert(
                    "muse".into(),
                    Arc::new(MuseAdapter::new(MuseAdapterConfig::fake(
                        parsed.data_directory.clone(),
                        script,
                    ))),
                );
            }
            "opencode" => {
                let script = fixtures.join("fakeOpenCodeServer.mjs");
                providers.insert(
                    "opencode".into(),
                    Arc::new(OpenCodeAdapter::new(OpenCodeAdapterConfig::fake(
                        parsed.data_directory.clone(),
                        script,
                    ))),
                );
            }
            "cursor" => {
                let script = fixtures.join("fakeCursorAgent.mjs");
                providers.insert(
                    "cursor".into(),
                    Arc::new(AcpAdapter::new(AcpAdapterConfig::fake(
                        AcpFlavor::Cursor,
                        parsed.data_directory.clone(),
                        script,
                    ))),
                );
            }
            "antigravity" => {
                let script = fixtures.join("fakeAntigravityAgent.mjs");
                providers.insert(
                    "antigravity".into(),
                    Arc::new(AcpAdapter::new(AcpAdapterConfig::fake(
                        AcpFlavor::Antigravity,
                        parsed.data_directory.clone(),
                        script,
                    ))),
                );
            }
            other => {
                eprintln!("Unsupported fake provider: {other}");
                let _ = release_host_lock(&lock_path, &lease);
                return ExitCode::from(1);
            }
        }
    } else if parsed.mock_provider.is_none() && parsed.enable_providers {
        providers.insert(
            "codex".into(),
            Arc::new(CodexAdapter::new(CodexAdapterConfig::native(
                parsed.data_directory.clone(),
            ))),
        );
        providers.insert(
            "claude".into(),
            Arc::new(ClaudeAdapter::new(ClaudeAdapterConfig::native(
                parsed.data_directory.clone(),
            ))),
        );
        for flavor in [
            AcpFlavor::Grok,
            AcpFlavor::Devin,
            AcpFlavor::Cursor,
            AcpFlavor::Hermes,
            AcpFlavor::Antigravity,
        ] {
            providers.insert(
                flavor.id().into(),
                Arc::new(AcpAdapter::new(AcpAdapterConfig::native(
                    flavor,
                    parsed.data_directory.clone(),
                ))),
            );
        }
        providers.insert(
            "muse".into(),
            Arc::new(MuseAdapter::new(MuseAdapterConfig::native(
                parsed.data_directory.clone(),
            ))),
        );
        providers.insert(
            "opencode".into(),
            Arc::new(OpenCodeAdapter::new(OpenCodeAdapterConfig::native(
                parsed.data_directory.clone(),
            ))),
        );
    }

    let server = match RunningServer::start(ServerConfig {
        data_directory: parsed.data_directory.clone(),
        host_id,
        port: parsed.port,
        sotto_version: parsed.sotto_version,
        started_by: parsed.started_by,
        credentials,
        providers,
        tailscale: None,
        phone_retry_interval: None,
    })
    .await
    {
        Ok(srv) => srv,
        Err(err) => {
            eprintln!("Could not start host listener: {err}");
            let _ = release_host_lock(&lock_path, &lease);
            return ExitCode::from(1);
        }
    };

    eprintln!("[Sotto] host-ready");
    if let Ok(line) = server.state.descriptor().ready_line() {
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{line}");
        let _ = stdout.flush();
    }

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
    async fn health_pair_allow_answers_session_and_websocket_protocol_v1_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let host_id = load_host_identity(dir.path()).unwrap();
        let credentials = HostCredentials::open(dir.path(), None).unwrap();
        let mut providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
        providers.insert("codex".into(), Arc::new(MockProviderAdapter::new("codex")));

        let srv = RunningServer::start(ServerConfig {
            data_directory: dir.path().to_path_buf(),
            host_id: host_id.clone(),
            port: 0,
            sotto_version: "0.1.44-owl.20261118.2".into(),
            started_by: None,
            credentials,
            providers,
            tailscale: None,
            phone_retry_interval: None,
        })
        .await
        .unwrap();
        let port = srv.state.port;
        let admin_token = srv.state.admin_token.clone();

        let (status, health) = http_request(port, "GET", "/v1/health", None, None).await;
        assert_eq!(status, 200);
        assert_eq!(health["hostId"], host_id);
        assert_eq!(health["sottoVersion"], "0.1.44-owl.20261118.2");
        assert_eq!(health["status"], "ready");
        assert!(health.get("adminToken").is_none());
        let features: Vec<&str> = health["features"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect();
        assert!(!features.contains(&"answer-receipts"));
        assert!(!features.contains(&"provider-deepseek"));
        assert!(features.contains(&"usage-dashboard"));
        assert!(features.contains(&"usage-antigravity-no-limits"));
        assert!(features.contains(&"subagents"));

        let (status, _) =
            http_request(port, "POST", "/v1/admin/pairing-code", Some("wrong"), None).await;
        assert_eq!(status, 401);

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

        let pair_body =
            serde_json::json!({ "v": 1, "code": code, "name": "Test Desktop" }).to_string();
        let (status, paired) =
            http_request(port, "POST", "/v1/pair", None, Some(&pair_body)).await;
        assert_eq!(status, 200);
        let client_id = paired["clientId"].as_str().unwrap();
        let token = paired["token"].as_str().unwrap();

        let allow_body = serde_json::json!({ "clientId": client_id }).to_string();
        let (status, allowed) = http_request(
            port,
            "POST",
            "/v1/admin/allow-answers",
            Some(&admin_token),
            Some(&allow_body),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(allowed["ok"], true);

        let (status, session_res) =
            http_request(port, "POST", "/v1/session", Some(token), None).await;
        assert_eq!(status, 200);
        let session = session_res["session"].as_str().unwrap();

        // Upgrade WebSocket (uncompressed for raw frame verification here)
        let mut ws = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let upgrade = format!(
            "GET /v1/socket HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: Bearer {session}\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        ws.write_all(upgrade.as_bytes()).await.unwrap();
        let mut ws_reader = BufReader::new(ws);
        let mut resp_line = String::new();
        ws_reader.read_line(&mut resp_line).await.unwrap();
        assert!(resp_line.starts_with("HTTP/1.1 101"));
        loop {
            let mut h = String::new();
            ws_reader.read_line(&mut h).await.unwrap();
            if h == "\r\n" || h == "\n" {
                break;
            }
        }

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
        assert_eq!(parsed["result"]["clientId"], client_id);
        assert_eq!(parsed["result"]["capabilities"]["mayAnswer"], true);
        assert_eq!(parsed["result"]["shell"]["hostId"], host_id);
        assert_eq!(parsed["result"]["shell"]["host"]["hostId"], host_id);
        assert_eq!(parsed["result"]["phoneAccess"]["status"], "off");
        assert_eq!(parsed["result"]["phoneAccess"]["phones"], 0);

        // Revoking the paired client immediately closes the already-open WebSocket.
        let revoke_body = serde_json::json!({ "clientId": client_id }).to_string();
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

        // Wait for Close frame (0x8) or EOF, draining any in-flight coordinator text/ping pushes
        // that may already have been queued on the socket before revoke took effect (#2850).
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let mut hdr = [0u8; 2];
                match ws_stream.read_exact(&mut hdr).await {
                    Err(err) => {
                        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof);
                        break;
                    }
                    Ok(_) => {
                        let opcode = hdr[0] & 0x0f;
                        if opcode == 0x8 {
                            break;
                        }
                        let len_b = hdr[1] & 0x7f;
                        let payload_len = if len_b == 126 {
                            let mut ext = [0u8; 2];
                            if ws_stream.read_exact(&mut ext).await.is_err() {
                                break;
                            }
                            u16::from_be_bytes(ext) as usize
                        } else if len_b == 127 {
                            let mut ext = [0u8; 8];
                            if ws_stream.read_exact(&mut ext).await.is_err() {
                                break;
                            }
                            u64::from_be_bytes(ext) as usize
                        } else {
                            len_b as usize
                        };
                        let mut discard = vec![0u8; payload_len];
                        if ws_stream.read_exact(&mut discard).await.is_err() {
                            break;
                        }
                    }
                }
            }
        })
        .await
        .expect("WebSocket should close promptly after client revocation");

        // Oversized HTTP header line is rejected without unbounded buffering.
        let mut big = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let huge = format!(
            "GET /v1/health HTTP/1.1\r\nX-Pad: {}\r\n\r\n",
            "a".repeat(20_000)
        );
        let _ = big.write_all(huge.as_bytes()).await;
        let mut big_reader = BufReader::new(big);
        let mut status_line = String::new();
        big_reader.read_line(&mut status_line).await.unwrap();
        assert!(status_line.starts_with("HTTP/1.1 413"));

        srv.close().await;
        assert!(!dir.path().join("host-listener.json").exists());
    }

    struct MockTailscaleState {
        serve_config: sotto_core::ServeConfig,
        serve_calls: Vec<(u16, u16)>,
        unserve_calls: Vec<u16>,
    }

    struct MockTailscale {
        dns_name: String,
        host_name: String,
        state: std::sync::Mutex<MockTailscaleState>,
    }

    impl MockTailscale {
        fn running(dns_name: &str, host_name: &str) -> Arc<Self> {
            Arc::new(Self {
                dns_name: dns_name.into(),
                host_name: host_name.into(),
                state: std::sync::Mutex::new(MockTailscaleState {
                    serve_config: sotto_core::ServeConfig::default(),
                    serve_calls: Vec::new(),
                    unserve_calls: Vec::new(),
                }),
            })
        }
    }

    impl sotto_core::TailscaleBackend for MockTailscale {
        fn status(&self) -> sotto_core::TailscaleStatus {
            sotto_core::TailscaleStatus::Running {
                dns_name: self.dns_name.clone(),
                host_name: self.host_name.clone(),
                others: Vec::new(),
            }
        }

        fn serve_status(&self) -> Result<sotto_core::ServeConfig, sotto_core::ServeStatusError> {
            Ok(self.state.lock().unwrap().serve_config.clone())
        }

        fn serve(&self, port: u16, loopback_port: u16) -> sotto_core::ServeResult {
            let mut st = self.state.lock().unwrap();
            st.serve_calls.push((port, loopback_port));
            let mut tcp = st.serve_config.tcp.take().unwrap_or_default();
            tcp.insert(
                port.to_string(),
                Some(sotto_core::phone_access::ServeTcpEntry {
                    https: Some(true),
                    ..Default::default()
                }),
            );
            st.serve_config.tcp = Some(tcp);
            let mut web = st.serve_config.web.take().unwrap_or_default();
            let mut handlers = BTreeMap::new();
            handlers.insert(
                "/".to_string(),
                Some(sotto_core::phone_access::ServeHandler {
                    proxy: Some(sotto_core::serve_target(loopback_port)),
                    ..Default::default()
                }),
            );
            web.insert(
                format!("{}:{port}", self.dns_name),
                Some(sotto_core::phone_access::ServeWebEntry {
                    handlers: Some(handlers),
                }),
            );
            st.serve_config.web = Some(web);
            sotto_core::ServeResult::Ok
        }

        fn unserve(&self, port: u16) -> bool {
            let mut st = self.state.lock().unwrap();
            st.unserve_calls.push(port);
            if let Some(ref mut tcp) = st.serve_config.tcp {
                tcp.remove(&port.to_string());
            }
            if let Some(ref mut web) = st.serve_config.web {
                let suffix = format!(":{port}");
                web.retain(|k, _| !k.ends_with(&suffix));
            }
            true
        }
    }

    async fn ws_connect_and_hello(port: u16, session: &str) -> (TcpStream, serde_json::Value) {
        let mut ws = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let upgrade = format!(
            "GET /v1/socket HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: Bearer {session}\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        ws.write_all(upgrade.as_bytes()).await.unwrap();
        let mut ws_reader = BufReader::new(ws);
        let mut resp_line = String::new();
        ws_reader.read_line(&mut resp_line).await.unwrap();
        assert!(resp_line.starts_with("HTTP/1.1 101"), "unexpected: {resp_line}");
        loop {
            let mut h = String::new();
            ws_reader.read_line(&mut h).await.unwrap();
            if h == "\r\n" || h == "\n" {
                break;
            }
        }
        let mut ws_stream = ws_reader.into_inner();
        let hello = r#"{"v":1,"id":"h1","op":"hello","accepts":["changed-thread-records","kept-parts","model-catalog-revision"]}"#;
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        let mut frame = vec![0x81, 0x80 | (hello.len() as u8)];
        frame.extend_from_slice(&mask);
        for (idx, b) in hello.as_bytes().iter().enumerate() {
            frame.push(b ^ mask[idx & 3]);
        }
        ws_stream.write_all(&frame).await.unwrap();
        ws_stream.flush().await.unwrap();

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
        (ws_stream, serde_json::from_slice(&resp_payload).unwrap())
    }

    #[tokio::test]
    async fn tailnet_phone_access_admin_routes_descriptor_and_shutdown_parity() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "version": 1,
                "tailnetConnections": true,
                "phoneAccess": false,
                "phoneAccessName": "Forge Box",
                "otherSetting": "keep-me"
            }))
            .unwrap(),
        )
        .unwrap();

        let host_id = load_host_identity(dir.path()).unwrap();
        let credentials = HostCredentials::open(dir.path(), None).unwrap();
        let mut providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
        providers.insert("codex".into(), Arc::new(MockProviderAdapter::new("codex")));
        let ts = MockTailscale::running("forge.tail123.ts.net", "forge");

        let srv = RunningServer::start(ServerConfig {
            data_directory: dir.path().to_path_buf(),
            host_id: host_id.clone(),
            port: 0,
            sotto_version: "0.1.44-owl.20261124.1".into(),
            started_by: Some("launch-script".into()),
            credentials,
            providers,
            tailscale: Some(ts.clone()),
            phone_retry_interval: Some(std::time::Duration::from_secs(60)),
        })
        .await
        .unwrap();

        // Wait for background PhoneAccessManager startup to finish Serve :8443 setup.
        srv.state.phones.wait_started().await;
        let port = srv.state.port;
        let admin_token = srv.state.admin_token.clone();

        // host-listener.json should be updated with tailnetAddress once Serve comes up.
        let expected_addr = "https://forge.tail123.ts.net:8443";
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(dir.path().join("host-listener.json")) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                        if val.get("tailnetAddress").and_then(serde_json::Value::as_str)
                            == Some(expected_addr)
                        {
                            break;
                        }
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("host-listener.json should record tailnetAddress");

        let (status, health) = http_request(port, "GET", "/v1/health", None, None).await;
        assert_eq!(status, 200);
        assert_eq!(health["tailnetAddress"], expected_addr);
        assert_eq!(health["startedBy"], "launch-script");

        let tailnet_port = ts.state.lock().unwrap().serve_calls[0].1;
        assert_eq!(ts.state.lock().unwrap().serve_calls[0].0, 8443);

        // Tailnet listener exposes computer name on /v1/health and refuses /v1/admin/*.
        let (status, t_health) = http_request(tailnet_port, "GET", "/v1/health", None, None).await;
        assert_eq!(status, 200);
        assert_eq!(t_health["name"], "Forge Box");
        assert_eq!(t_health["tailnetAddress"], expected_addr);

        let (status, _) = http_request(
            tailnet_port,
            "POST",
            "/v1/admin/phones",
            Some(&admin_token),
            Some("{}"),
        )
        .await;
        assert_eq!(status, 400);

        // While phoneAccess is false, /v1/pair on the tailnet listener returns 403 forbidden.
        let (status, pair_refused) = http_request(
            tailnet_port,
            "POST",
            "/v1/pair",
            None,
            Some(r#"{"v":1,"code":"ABCDEFGH","name":"Phone"}"#),
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(pair_refused["error"]["code"], "forbidden");

        // Pair a desktop over the admin listener and record it in desktop-clients.json.
        let (_, code_res) = http_request(
            port,
            "POST",
            "/v1/admin/pairing-code",
            Some(&admin_token),
            None,
        )
        .await;
        let desktop_pair_body = serde_json::json!({
            "v": 1,
            "code": code_res["code"],
            "name": "Zach Laptop",
        })
        .to_string();
        let (status, desktop_paired) =
            http_request(port, "POST", "/v1/pair", None, Some(&desktop_pair_body)).await;
        assert_eq!(status, 200);
        let desktop_id = desktop_paired["clientId"].as_str().unwrap().to_string();
        let desktop_token = desktop_paired["token"].as_str().unwrap().to_string();
        std::fs::write(
            dir.path().join("desktop-clients.json"),
            serde_json::to_string(&vec![&desktop_id]).unwrap(),
        )
        .unwrap();

        // Recorded desktop can connect over the tailnet listener even with phoneAccess off.
        let (status, t_sess) =
            http_request(tailnet_port, "POST", "/v1/session", Some(&desktop_token), None).await;
        assert_eq!(status, 200);
        let (desktop_ws, desktop_hello) =
            ws_connect_and_hello(tailnet_port, t_sess["session"].as_str().unwrap()).await;
        assert_eq!(desktop_hello["result"]["tailnetAddress"], expected_addr);
        assert_eq!(desktop_hello["result"]["startedBy"], "launch-script");
        assert_eq!(desktop_hello["result"]["phoneAccess"]["status"], "off");
        assert_eq!(desktop_hello["result"]["phoneAccess"]["phones"], 0);
        assert_eq!(desktop_hello["result"]["shell"]["hostId"], host_id);
        drop(desktop_ws);

        // Turn phoneAccess on via /v1/admin/phones-command.
        let (status, enabled_res) = http_request(
            port,
            "POST",
            "/v1/admin/phones-command",
            Some(&admin_token),
            Some(r#"{"command":{"type":"set-enabled","enabled":true}}"#),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(enabled_res["state"]["enabled"], true);
        assert_eq!(enabled_res["state"]["phase"], "on");
        let saved_settings: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved_settings["phoneAccess"], true);
        assert_eq!(saved_settings["otherSetting"], "keep-me");

        // Show pairing code and pair a phone through the tailnet listener.
        let (status, show_res) = http_request(
            port,
            "POST",
            "/v1/admin/phones-command",
            Some(&admin_token),
            Some(r#"{"command":{"type":"show-code"}}"#),
        )
        .await;
        assert_eq!(status, 200);
        let phone_code = show_res["state"]["code"]["code"].as_str().unwrap();
        let phone_pair_body = serde_json::json!({
            "v": 1,
            "code": phone_code,
            "name": "Zach iPhone",
        })
        .to_string();
        let (status, phone_paired) =
            http_request(tailnet_port, "POST", "/v1/pair", None, Some(&phone_pair_body)).await;
        assert_eq!(status, 200);
        let phone_id = phone_paired["clientId"].as_str().unwrap().to_string();
        let phone_token = phone_paired["token"].as_str().unwrap().to_string();

        // Phone opens WebSocket on tailnet listener; admin /v1/admin/phones sees connected == true
        // and only lists the phone (never the desktop).
        let (status, p_sess) =
            http_request(tailnet_port, "POST", "/v1/session", Some(&phone_token), None).await;
        assert_eq!(status, 200);
        let (_phone_ws, phone_hello) =
            ws_connect_and_hello(tailnet_port, p_sess["session"].as_str().unwrap()).await;
        assert_eq!(phone_hello["result"]["capabilities"]["mayAnswer"], true);
        assert_eq!(phone_hello["result"]["shell"]["hostId"], host_id);
        assert!(phone_hello["result"].get("phoneAccess").is_none());

        let (status, phones_read) =
            http_request(port, "POST", "/v1/admin/phones", Some(&admin_token), Some("{}")).await;
        assert_eq!(status, 200);
        assert_eq!(phones_read["state"]["phones"].as_array().unwrap().len(), 1);
        assert_eq!(phones_read["state"]["phones"][0]["clientId"], phone_id);
        assert_eq!(phones_read["state"]["phones"][0]["connected"], true);
        assert_eq!(phones_read["state"]["phones"][0]["canAnswer"], true);

        // Desktop hello reports phoneAccess: { status: "on", phones: 1 }.
        let (status, d_sess2) =
            http_request(port, "POST", "/v1/session", Some(&desktop_token), None).await;
        assert_eq!(status, 200);
        let (_d_ws2, d_hello2) =
            ws_connect_and_hello(port, d_sess2["session"].as_str().unwrap()).await;
        assert_eq!(d_hello2["result"]["phoneAccess"]["status"], "on");
        assert_eq!(d_hello2["result"]["phoneAccess"]["phones"], 1);

        // deny-answers refuses a paired phone; remove refuses a paired desktop.
        let deny_phone = serde_json::json!({ "clientId": phone_id }).to_string();
        let (status, _) = http_request(
            port,
            "POST",
            "/v1/admin/deny-answers",
            Some(&admin_token),
            Some(&deny_phone),
        )
        .await;
        assert_eq!(status, 400);

        let remove_desktop = serde_json::json!({
            "command": { "type": "remove", "clientId": desktop_id }
        })
        .to_string();
        let (status, rem_d_res) = http_request(
            port,
            "POST",
            "/v1/admin/phones-command",
            Some(&admin_token),
            Some(&remove_desktop),
        )
        .await;
        assert_eq!(status, 200);
        assert!(rem_d_res["error"].as_str().is_some());

        // Turn phoneAccess off while tailnetConnections stays true; Serve stays up.
        let (status, _) = http_request(
            port,
            "POST",
            "/v1/admin/phones-command",
            Some(&admin_token),
            Some(r#"{"command":{"type":"set-enabled","enabled":false}}"#),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(srv.state.phones.address().as_deref(), Some(expected_addr));

        // Revoking the last desktop automatically turns tailnetConnections off and removes Serve.
        let revoke_desktop = serde_json::json!({ "clientId": desktop_id }).to_string();
        let (status, _) = http_request(
            port,
            "POST",
            "/v1/admin/revoke-client",
            Some(&admin_token),
            Some(&revoke_desktop),
        )
        .await;
        assert_eq!(status, 200);
        let (status, tailnet_after) =
            http_request(port, "POST", "/v1/admin/tailnet", Some(&admin_token), Some("{}")).await;
        assert_eq!(status, 200);
        assert_eq!(tailnet_after["enabled"], false);
        assert_eq!(tailnet_after["state"]["phase"], "off");
        assert!(ts.state.lock().unwrap().unserve_calls.contains(&8443));

        // Re-enabling tailnetConnections via /v1/admin/tailnet brings Serve :8443 back,
        // and closing the server unserves :8443 cleanly.
        let (status, tailnet_on) = http_request(
            port,
            "POST",
            "/v1/admin/tailnet",
            Some(&admin_token),
            Some(r#"{"enabled":true}"#),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(tailnet_on["enabled"], true);
        assert_eq!(tailnet_on["state"]["phase"], "on");
        assert_eq!(tailnet_on["state"]["address"], expected_addr);

        let unserve_before_close = ts.state.lock().unwrap().unserve_calls.len();
        srv.close().await;
        assert_eq!(
            ts.state.lock().unwrap().unserve_calls.len(),
            unserve_before_close + 1
        );
        assert!(!dir.path().join("host-listener.json").exists());
    }
}
