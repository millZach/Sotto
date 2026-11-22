mod transport;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

use sotto_core::{
    acquire_host_lock, load_host_identity, read_boot_id, release_host_lock, AcpAdapter,
    AcpAdapterConfig, AcpFlavor, ClaudeAdapter, ClaudeAdapterConfig, ClientContext, CodexAdapter,
    CodexAdapterConfig, CoordinatorBroadcast, CoordinatorError, CoordinatorHandle, HostLease,
    MockProviderAdapter, MuseAdapter, MuseAdapterConfig, OpenCodeAdapter, OpenCodeAdapterConfig,
    ProviderAdapter,
};

use crate::transport::{
    connect_engine_stream, err_response_frame, hello_frame, ok_response_frame, push_frame,
    read_engine_frame, write_engine_frame, IncomingEngineMessage, SerializedEngineError,
};

const ENGINE_VERSION: &str = match option_env!("SOTTO_HOST_VERSION") {
    Some(v) if !v.is_empty() => v,
    _ => env!("CARGO_PKG_VERSION"),
};

#[derive(Debug)]
struct EngineCliArgs {
    data_directory: PathBuf,
    endpoint: String,
    token: String,
    mock_provider: Option<String>,
    fake_provider: Option<String>,
    fixtures_dir: Option<PathBuf>,
    enable_providers: bool,
}

fn parse_args(args: &[String]) -> Result<EngineCliArgs, String> {
    let mut data_directory = std::env::var("SOTTO_ENGINE_DATA").ok().map(PathBuf::from);
    let mut endpoint = std::env::var("SOTTO_ENGINE_ENDPOINT").ok();
    let token = std::env::var("SOTTO_ENGINE_TOKEN")
        .ok()
        .filter(|v| !v.is_empty());
    let mut mock_provider = None;
    let mut fake_provider = None;
    let mut fixtures_dir = None;

    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        if !matches!(
            flag,
            "--data" | "--endpoint" | "--mock-provider" | "--fake" | "--fixtures-dir"
        ) {
            return Err("Use --data <folder> --endpoint <pipe-or-socket>.".into());
        }
        i += 1;
        let Some(value) = args.get(i).filter(|v| !v.is_empty() && !v.starts_with("--")) else {
            return Err("Each engine option needs a value.".into());
        };
        match flag {
            "--data" => data_directory = Some(PathBuf::from(value)),
            "--endpoint" => endpoint = Some(value.clone()),
            "--mock-provider" => mock_provider = Some(value.clone()),
            "--fake" => fake_provider = Some(value.clone()),
            "--fixtures-dir" => fixtures_dir = Some(PathBuf::from(value)),
            _ => unreachable!(),
        }
        i += 1;
    }

    let Some(data_directory) = data_directory.filter(|p| !p.as_os_str().is_empty()) else {
        return Err("Provide --data <folder> or SOTTO_ENGINE_DATA.".into());
    };
    let Some(endpoint) = endpoint.filter(|s| !s.trim().is_empty()) else {
        return Err("Provide --endpoint <pipe-or-socket> or SOTTO_ENGINE_ENDPOINT.".into());
    };
    let Some(token) = token else {
        return Err("SOTTO_ENGINE_TOKEN is required.".into());
    };

    let enable_providers = std::env::var("SOTTO_ENGINE_ENABLE_PROVIDERS").as_deref() == Ok("1");

    Ok(EngineCliArgs {
        data_directory,
        endpoint,
        token,
        mock_provider,
        fake_provider,
        fixtures_dir,
        enable_providers,
    })
}

fn build_providers(args: &EngineCliArgs) -> Result<BTreeMap<String, Arc<dyn ProviderAdapter>>, String> {
    let mut providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
    if let Some(ref mock_id) = args.mock_provider {
        providers.insert(mock_id.clone(), Arc::new(MockProviderAdapter::new(mock_id)));
    }
    if let Some(ref fake_id) = args.fake_provider {
        let fixtures = args
            .fixtures_dir
            .clone()
            .unwrap_or_else(|| PathBuf::from("tests/fixtures"));
        match fake_id.as_str() {
            "codex" => {
                providers.insert(
                    "codex".into(),
                    Arc::new(CodexAdapter::new(CodexAdapterConfig::fake(
                        args.data_directory.clone(),
                        fixtures.join("fakeCodexAppServer.mjs"),
                    ))),
                );
            }
            "claude" => {
                providers.insert(
                    "claude".into(),
                    Arc::new(ClaudeAdapter::new(ClaudeAdapterConfig::fake(
                        args.data_directory.clone(),
                        fixtures.join("fakeClaudeThread.mjs"),
                    ))),
                );
            }
            "grok" => {
                providers.insert(
                    "grok".into(),
                    Arc::new(AcpAdapter::new(AcpAdapterConfig::fake(
                        AcpFlavor::Grok,
                        args.data_directory.clone(),
                        fixtures.join("fakeGrokThreadAgent.mjs"),
                    ))),
                );
            }
            "devin" => {
                providers.insert(
                    "devin".into(),
                    Arc::new(AcpAdapter::new(AcpAdapterConfig::fake(
                        AcpFlavor::Devin,
                        args.data_directory.clone(),
                        fixtures.join("fakeDevinAgent.mjs"),
                    ))),
                );
            }
            "muse" => {
                providers.insert(
                    "muse".into(),
                    Arc::new(MuseAdapter::new(MuseAdapterConfig::fake(
                        args.data_directory.clone(),
                        fixtures.join("fakeMuseAgent.mjs"),
                    ))),
                );
            }
            "opencode" => {
                providers.insert(
                    "opencode".into(),
                    Arc::new(OpenCodeAdapter::new(OpenCodeAdapterConfig::fake(
                        args.data_directory.clone(),
                        fixtures.join("fakeOpenCodeServer.mjs"),
                    ))),
                );
            }
            "cursor" => {
                providers.insert(
                    "cursor".into(),
                    Arc::new(AcpAdapter::new(AcpAdapterConfig::fake(
                        AcpFlavor::Cursor,
                        args.data_directory.clone(),
                        fixtures.join("fakeCursorAgent.mjs"),
                    ))),
                );
            }
            "antigravity" => {
                providers.insert(
                    "antigravity".into(),
                    Arc::new(AcpAdapter::new(AcpAdapterConfig::fake(
                        AcpFlavor::Antigravity,
                        args.data_directory.clone(),
                        fixtures.join("fakeAntigravityAgent.mjs"),
                    ))),
                );
            }
            other => return Err(format!("Unsupported fake provider: {other}")),
        }
    } else if args.mock_provider.is_none() && args.enable_providers {
        providers.insert(
            "codex".into(),
            Arc::new(CodexAdapter::new(CodexAdapterConfig::native(
                args.data_directory.clone(),
            ))),
        );
        providers.insert(
            "claude".into(),
            Arc::new(ClaudeAdapter::new(ClaudeAdapterConfig::native(
                args.data_directory.clone(),
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
                    args.data_directory.clone(),
                ))),
            );
        }
        providers.insert(
            "muse".into(),
            Arc::new(MuseAdapter::new(MuseAdapterConfig::native(
                args.data_directory.clone(),
            ))),
        );
        providers.insert(
            "opencode".into(),
            Arc::new(OpenCodeAdapter::new(OpenCodeAdapterConfig::native(
                args.data_directory.clone(),
            ))),
        );
    }
    Ok(providers)
}

fn coord_err(err: CoordinatorError) -> SerializedEngineError {
    SerializedEngineError {
        name: "Error".into(),
        message: err.message,
        code: Some(err.code.as_str().into()),
    }
}

async fn handle_rpc(
    coordinator: &CoordinatorHandle,
    data_directory: &Path,
    method: &str,
    args: &[Value],
) -> Result<Value, SerializedEngineError> {
    let err_invalid = |msg: &str| SerializedEngineError {
        name: "Error".into(),
        message: msg.into(),
        code: Some("invalid_request".into()),
    };

    match method {
        "engine.ping" => Ok(json!({
            "ok": true,
            "runtime": "rust",
            "version": ENGINE_VERSION,
            "pid": std::process::id(),
        })),
        "agent.snapshot" | "agent.shell" => {
            let shell = coordinator.shell(true).await.map_err(coord_err)?;
            Ok(shell)
        }
        "agent.detail" => {
            let tid = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("threadId is required."))?;
            let detail = coordinator
                .detail(tid.to_string())
                .await
                .map_err(coord_err)?;
            let val = match detail {
                Some(d) => serde_json::to_value(d).unwrap_or(Value::Null),
                None => Value::Null,
            };
            Ok(val)
        }
        "agent.observe" => {
            let ids: Vec<String> = args
                .first()
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(ToString::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let observed = coordinator.observe(ids).await.map_err(coord_err)?;
            let out: Vec<Value> = observed
                .into_iter()
                .map(|(tid, d)| {
                    json!({
                        "threadId": tid,
                        "detail": d.and_then(|v| serde_json::to_value(v).ok()),
                    })
                })
                .collect();
            Ok(json!({ "details": out }))
        }
        "agent.events" => {
            let tid = args.first().and_then(Value::as_str).map(ToString::to_string);
            let after_seq = args.get(1).and_then(Value::as_i64).unwrap_or(0);
            let limit = args
                .get(2)
                .and_then(Value::as_u64)
                .unwrap_or(200)
                .min(500) as usize;
            let (events, has_more, latest_seq) = coordinator
                .events(tid, after_seq, limit)
                .await
                .map_err(coord_err)?;
            Ok(json!({
                "events": events,
                "hasMore": has_more,
                "latestSeq": latest_seq,
            }))
        }
        "ops.hostFacts" => {
            let running = coordinator.running_threads_count().await.unwrap_or(0);
            let val = tokio::task::spawn_blocking(move || sotto_core::ops::host_facts(running))
                .await
                .unwrap_or_else(|_| json!({}));
            Ok(val)
        }
        "ops.threadFiles" => {
            let tid = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("threadId is required."))?;
            let rel = args.get(1).and_then(Value::as_str).unwrap_or("").to_string();
            let req_ws_id = args.get(2).and_then(Value::as_str);
            if !rel.is_empty() && req_ws_id.is_none() {
                return Ok(sotto_core::ops::tools_err(
                    "workspace-changed",
                    "Refresh the workspace first.",
                ));
            }
            let Some(ws) = coordinator
                .thread_workspace(tid.to_string())
                .await
                .ok()
                .flatten()
            else {
                return Ok(sotto_core::ops::tools_err(
                    "thread-unavailable",
                    "This thread is unavailable.",
                ));
            };
            if let Some(expected_ws) = req_ws_id {
                if expected_ws != ws.workspace_id {
                    return Ok(sotto_core::ops::tools_err(
                        "workspace-changed",
                        "This thread's working folder changed. Refresh and try again.",
                    ));
                }
            }
            let val = tokio::task::spawn_blocking(move || sotto_core::ops::thread_files(&ws, &rel))
                .await
                .unwrap_or_else(|_| sotto_core::ops::tools_err("unavailable", "Could not read files."));
            Ok(val)
        }
        "ops.threadFilePreview" => {
            let tid = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("threadId is required."))?;
            let rel = args
                .get(1)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let expected_ws = args
                .get(2)
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("workspaceId is required."))?;
            let Some(ws) = coordinator
                .thread_workspace(tid.to_string())
                .await
                .ok()
                .flatten()
            else {
                return Ok(sotto_core::ops::tools_err(
                    "thread-unavailable",
                    "This thread is unavailable.",
                ));
            };
            if expected_ws != ws.workspace_id {
                return Ok(sotto_core::ops::tools_err(
                    "workspace-changed",
                    "This thread's working folder changed. Refresh and try again.",
                ));
            }
            let val = tokio::task::spawn_blocking(move || {
                sotto_core::ops::thread_file_preview(&ws, &rel)
            })
            .await
            .unwrap_or_else(|_| sotto_core::ops::tools_err("unavailable", "Could not preview file."));
            Ok(val)
        }
        "ops.gitRefs" => {
            let tid = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("threadId is required."))?;
            let Some(ws) = coordinator
                .thread_workspace(tid.to_string())
                .await
                .ok()
                .flatten()
            else {
                return Err(SerializedEngineError {
                    name: "Error".into(),
                    message: "This thread is unavailable.".into(),
                    code: Some("unavailable".into()),
                });
            };
            let opts = args.get(1).and_then(Value::as_object);
            let query = opts
                .and_then(|o| o.get("query"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let cursor = opts.and_then(|o| o.get("cursor")).and_then(|v| {
                v.as_u64()
                    .map(|n| n as usize)
                    .or_else(|| v.as_str().and_then(|s| s.parse::<usize>().ok()))
            });
            let limit = opts
                .and_then(|o| o.get("limit"))
                .and_then(Value::as_u64)
                .map(|n| n as usize);
            let include_matching_remote = opts
                .and_then(|o| {
                    o.get("includeMatchingRemoteRefs")
                        .or_else(|| o.get("includeMatchingRemote"))
                        .or_else(|| o.get("includeRemote"))
                })
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let folder = ws.working_directory;
            let val = tokio::task::spawn_blocking(move || {
                sotto_core::ops::git_refs(
                    &folder,
                    query.as_deref(),
                    cursor,
                    limit,
                    include_matching_remote,
                )
            })
            .await
            .map_err(|_| err_invalid("gitRefs task failed."))?
            .map_err(|e| SerializedEngineError {
                name: "Error".into(),
                message: e,
                code: Some("unavailable".into()),
            })?;
            Ok(val)
        }
        "ops.threadWords" => {
            let query = args
                .first()
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let dir = data_directory.to_path_buf();
            let val = tokio::task::spawn_blocking(move || {
                sotto_core::ops::search_thread_words(&dir, &query)
            })
            .await
            .unwrap_or_else(|_| json!({ "found": [] }));
            Ok(val)
        }
        other => Err(SerializedEngineError {
            name: "Error".into(),
            message: format!("ENGINE_METHOD_UNHANDLED: {other}"),
            code: Some("METHOD_NOT_FOUND".into()),
        }),
    }
}

fn main() -> ExitCode {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let parsed = match parse_args(&raw_args) {
        Ok(a) => a,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(1);
        }
    };
    // Scrub engine IPC secret and launch env vars before starting worker threads or
    // spawning provider child processes so no AI provider ever inherits SOTTO_ENGINE_TOKEN.
    std::env::remove_var("SOTTO_ENGINE_TOKEN");
    std::env::remove_var("SOTTO_ENGINE_ENDPOINT");
    std::env::remove_var("SOTTO_ENGINE_DATA");
    std::env::remove_var("SOTTO_ENGINE_ENABLE_PROVIDERS");

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
    let exit_code = runtime.block_on(run_engine(parsed));
    // Drop remaining async tasks within a bounded window so `kill_on_drop(true)` child handles
    // terminate owned provider processes before main returns.
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
    exit_code
}

async fn run_engine(parsed: EngineCliArgs) -> ExitCode {

    if let Err(err) = std::fs::create_dir_all(&parsed.data_directory) {
        eprintln!("Could not create engine data folder: {err}");
        return ExitCode::from(1);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(err) = std::fs::set_permissions(
            &parsed.data_directory,
            std::fs::Permissions::from_mode(0o700),
        ) {
            eprintln!("Could not secure engine data folder permissions: {err}");
            return ExitCode::from(1);
        }
    }

    let boot = read_boot_id();
    let lease = HostLease::current(boot.clone());
    let lock_path = parsed.data_directory.join("engine.lock");
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

    let providers = match build_providers(&parsed) {
        Ok(p) => p,
        Err(err) => {
            eprintln!("{err}");
            let _ = release_host_lock(&lock_path, &lease);
            return ExitCode::from(1);
        }
    };
    let provider_handles: Vec<Arc<dyn ProviderAdapter>> = providers.values().cloned().collect();

    let coordinator = match CoordinatorHandle::spawn(
        parsed.data_directory.clone(),
        host_id,
        true,
        providers,
    ) {
        Ok(c) => c,
        Err(err) => {
            eprintln!("Could not start engine coordinator: {err}");
            let _ = release_host_lock(&lock_path, &lease);
            return ExitCode::from(1);
        }
    };

    let stream = match connect_engine_stream(&parsed.endpoint).await {
        Ok(s) => s,
        Err(err) => {
            eprintln!("Could not connect to EngineTransport endpoint: {err}");
            coordinator.shutdown().await;
            let _ = release_host_lock(&lock_path, &lease);
            return ExitCode::from(1);
        }
    };

    let (mut read_half, mut write_half) = tokio::io::split(stream);
    if let Err(err) = write_engine_frame(&mut write_half, &hello_frame(&parsed.token)).await {
        eprintln!("Could not send engine hello frame: {err}");
        coordinator.shutdown().await;
        let _ = release_host_lock(&lock_path, &lease);
        return ExitCode::from(1);
    }

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
    let writer_task = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if write_engine_frame(&mut write_half, &frame).await.is_err() {
                break;
            }
        }
    });

    // Dedicated cancel-safe reader task.
    let (in_tx, mut in_rx) = mpsc::channel(64);
    let reader_task = tokio::spawn(async move {
        while let Ok(Some(msg)) = read_engine_frame(&mut read_half).await {
            if in_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut bcast_rx = coordinator.subscribe();
    let mut rpc_tasks: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();
    let mut shutdown_req_id: Option<u64> = None;
    let shutdown_signal = shutdown_future();
    tokio::pin!(shutdown_signal);

    loop {
        tokio::select! {
            _ = &mut shutdown_signal => {
                break;
            }
            bcast = bcast_rx.recv() => {
                match bcast {
                    Ok(CoordinatorBroadcast::Shell(shell)) => {
                        if out_tx.send(push_frame("shell", shell)).is_err() {
                            break;
                        }
                    }
                    Ok(CoordinatorBroadcast::Detail(detail)) => {
                        if let Ok(val) = serde_json::to_value(&detail) {
                            if out_tx.send(push_frame("detail", val)).is_err() {
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Ok(shell) = coordinator.shell(true).await {
                            let _ = out_tx.send(push_frame("shell", shell));
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            maybe_msg = in_rx.recv() => {
                let Some(msg) = maybe_msg else {
                    break;
                };
                while rpc_tasks.try_join_next().is_some() {}
                if let IncomingEngineMessage::Req { id, method, args } = msg {
                    if method == "engine.shutdown" {
                        shutdown_req_id = Some(id);
                        break;
                    }
                    if method == "agent.command" {
                        // Enqueue coordinator commands synchronously in strict arrival order before
                        // awaiting completion asynchronously, preventing multi-thread reordering.
                        let Some(cmd) = args.first().and_then(Value::as_object) else {
                            let _ = out_tx.send(err_response_frame(
                                id,
                                SerializedEngineError {
                                    name: "Error".into(),
                                    message: "Command object is required.".into(),
                                    code: Some("invalid_request".into()),
                                },
                            ));
                            continue;
                        };
                        let local_client = ClientContext {
                            client_id: "local-desktop".into(),
                            user: "Local Desktop".into(),
                            may_answer: true,
                        };
                        match coordinator.enqueue_command(local_client, cmd.clone()) {
                            Ok(reply_rx) => {
                                let out = out_tx.clone();
                                rpc_tasks.spawn(async move {
                                    let frame = match reply_rx.await {
                                        Ok(Ok(shell)) => ok_response_frame(id, shell),
                                        Ok(Err(err)) => err_response_frame(id, coord_err(err)),
                                        Err(_) => err_response_frame(
                                            id,
                                            SerializedEngineError {
                                                name: "Error".into(),
                                                message: "Host coordinator stopped.".into(),
                                                code: Some("unavailable".into()),
                                            },
                                        ),
                                    };
                                    let _ = out.send(frame);
                                });
                            }
                            Err(err) => {
                                let _ = out_tx.send(err_response_frame(id, coord_err(err)));
                            }
                        }
                        continue;
                    }
                    let coord = coordinator.clone();
                    let data_dir = parsed.data_directory.clone();
                    let out = out_tx.clone();
                    rpc_tasks.spawn(async move {
                        let frame = match handle_rpc(&coord, &data_dir, &method, &args).await {
                            Ok(val) => ok_response_frame(id, val),
                            Err(err) => err_response_frame(id, err),
                        };
                        let _ = out.send(frame);
                    });
                }
            }
        }
    }

    reader_task.abort();
    // Drain in-flight RPCs up to a bounded deadline before aborting stragglers, then flush
    // coordinator state before sending the `engine.shutdown` acknowledgement.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while rpc_tasks.join_next().await.is_some() {}
    })
    .await;
    rpc_tasks.abort_all();
    while rpc_tasks.join_next().await.is_some() {}
    let shutdown_completed = tokio::time::timeout(
        std::time::Duration::from_secs(35),
        coordinator.shutdown(),
    )
    .await
    .is_ok();
    if let Some(id) = shutdown_req_id {
        let frame = if shutdown_completed {
            ok_response_frame(id, json!({ "ok": true }))
        } else {
            err_response_frame(
                id,
                SerializedEngineError {
                    name: "Error".into(),
                    message: "Engine shutdown timed out before coordinator finished saving state."
                        .into(),
                    code: Some("unavailable".into()),
                },
            )
        };
        let _ = out_tx.send(frame);
    }
    drop(out_tx);
    let mut writer_task = writer_task;
    if tokio::time::timeout(std::time::Duration::from_secs(2), &mut writer_task)
        .await
        .is_err()
    {
        writer_task.abort();
    }
    if shutdown_completed {
        let _ = release_host_lock(&lock_path, &lease);
        ExitCode::SUCCESS
    } else {
        // Attempt direct provider teardown before returning non-zero; `runtime.shutdown_timeout`
        // in `main` then drops any remaining tasks so `kill_on_drop(true)` terminates children,
        // and the next start safely reclaims the dead-PID lock.
        let mut disconnects: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();
        for provider in provider_handles {
            disconnects.spawn(async move {
                let _ = provider.disconnect().await;
            });
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while disconnects.join_next().await.is_some() {}
        })
        .await;
        disconnects.abort_all();
        ExitCode::from(1)
    }
}

async fn shutdown_future() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate()).ok();
        let ctrl_c = tokio::signal::ctrl_c();
        match sigterm.as_mut() {
            Some(term) => {
                tokio::select! {
                    _ = ctrl_c => {}
                    _ = term.recv() => {}
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
