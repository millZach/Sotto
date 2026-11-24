mod shell_bridge;
mod transport;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex, Semaphore};

use sotto_core::{
    acquire_host_lock, inspect_checkpoint_blobs, load_host_identity, probe_tailscale_status,
    read_boot_id, read_checkpoints_readonly, read_phone_access_readonly, release_host_lock,
    AcpAdapter, AcpAdapterConfig, AcpFlavor, CheckpointBlobPair, CheckpointManager,
    CheckpointThreadInfo, ClaudeAdapter, ClaudeAdapterConfig, ClientContext, CodexAdapter,
    CodexAdapterConfig, CoordinatorBroadcast, CoordinatorError, CoordinatorHandle, HostLease,
    LocalAppsManager, MemoryStore, MockProviderAdapter, MuseAdapter, MuseAdapterConfig,
    OpenCodeAdapter, OpenCodeAdapterConfig, PhoneAccessManager, PhoneAccessSettings,
    PhonesCommand, ProviderAdapter, SystemTailscaleCli,
};

use crate::shell_bridge::{CredentialSnapshot, EngineWindowFocus, ShellBridgeClient};
use crate::transport::{
    box_binary, connect_engine_stream, err_response_frame, ok_response_frame, push_frame,
    unbox_binary, EngineDuplex, IncomingEngineEvent, SerializedEngineError,
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
    accelerator: bool,
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
    let mut accelerator = false;

    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        if flag == "--accelerator" {
            accelerator = true;
            i += 1;
            continue;
        }
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
        accelerator,
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

#[allow(clippy::too_many_arguments)]
async fn handle_rpc(
    coordinator: &CoordinatorHandle,
    shell_bridge: &ShellBridgeClient,
    checkpoints: &Arc<Mutex<CheckpointManager>>,
    phone_access: &Arc<Mutex<PhoneAccessManager>>,
    local_apps: &Arc<Mutex<LocalAppsManager>>,
    host_id: &str,
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
        "engine:init" => {
            if let Some(payload) = args.first() {
                shell_bridge.apply_init(payload);
            }
            shell_bridge.log("rust-engine-initialized");
            Ok(json!({
                "metadata": {
                    "localHostId": host_id,
                    "hasOwnServers": false,
                    "hasOwnServerCleanup": false,
                    "hasCouncil": false,
                    "hasWatcher": false,
                    "keepMainCurrentEnabled": false,
                },
                "channels": [],
                "hasWatcherBridge": false,
            }))
        }
        "engine:perfReading" => Ok(json!({
            "blockedShare": 0,
            "longestFreezeMs": 0,
            "freezesOver100ms": 0,
            "bars": [],
        })),
        "engine:windowFocus" => {
            serde_json::to_value(shell_bridge.window_focus())
                .map_err(|_| err_invalid("Could not serialize window focus."))
        }
        "engine:readWritingSettings" => shell_bridge.read_writing_settings().await,
        "engine:openExternal" => {
            let url = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("url is required."))?;
            shell_bridge.open_external(url).await?;
            Ok(json!(true))
        }
        "engine:clipboardWrite" => {
            let text = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("text is required."))?;
            shell_bridge.clipboard_write(text).await?;
            Ok(json!(true))
        }
        "engine:credentialsSet" => {
            let slot = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("slot is required."))?;
            let value = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("value is required."))?;
            shell_bridge.credentials().set(slot, value).await?;
            Ok(json!({ "ok": true }))
        }
        "engine:credentialsHas" => {
            let slot = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("slot is required."))?;
            Ok(json!({
                "available": shell_bridge.credentials().available(),
                "has": shell_bridge.credentials().has(slot),
            }))
        }
        "engine:redrawPhoto" => {
            let bytes = args
                .first()
                .and_then(unbox_binary)
                .ok_or_else(|| err_invalid("Boxed binary photo bytes are required."))?;
            let kind = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("kind is required."))?;
            match shell_bridge.redraw_photo(&bytes, kind).await? {
                Some((out_bytes, out_kind)) => Ok(json!({
                    "bytes": box_binary(&out_bytes),
                    "kind": out_kind,
                })),
                None => Ok(Value::Null),
            }
        }
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
        "ops.usageQuery" => {
            let query = sotto_core::ops::parse_usage_read_query(args.first())
                .map_err(|e| err_invalid(&e))?;
            let dir = data_directory.to_path_buf();
            tokio::task::spawn_blocking(move || sotto_core::ops::usage_query_activity(&dir, &query))
                .await
                .map_err(|_| err_invalid("usageQuery task failed."))?
                .map_err(|e| SerializedEngineError {
                    name: "Error".into(),
                    message: e,
                    code: Some("unavailable".into()),
                })
        }
        "ops.gitChangedFiles" => {
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
            let budget = parse_timeout_budget(args.get(1), 9_000);
            let folder = ws.working_directory;
            tokio::task::spawn_blocking(move || {
                sotto_core::ops::git_changed_files_with_budget(&folder, budget)
            })
            .await
            .map_err(|_| err_invalid("gitChangedFiles task failed."))?
            .map_err(|e| SerializedEngineError {
                name: "Error".into(),
                message: e,
                code: Some("unavailable".into()),
            })
        }
        "ops.threadChanges" => {
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
                return Ok(sotto_core::ops::tools_err(
                    "thread-unavailable",
                    "This thread is unavailable.",
                ));
            };
            tokio::task::spawn_blocking(move || sotto_core::ops::thread_changes(&ws))
                .await
                .map_err(|_| err_invalid("threadChanges task failed."))
        }
        "ops.threadChangesReview" => {
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
                return Ok(sotto_core::ops::tools_err(
                    "thread-unavailable",
                    "This thread is unavailable.",
                ));
            };
            let scope = args
                .get(1)
                .cloned()
                .unwrap_or_else(|| json!({ "kind": "working" }));
            let ignore_whitespace = args
                .get(2)
                .and_then(Value::as_bool)
                .unwrap_or(false);
            tokio::task::spawn_blocking(move || {
                sotto_core::ops::thread_changes_review(&ws, &scope, ignore_whitespace)
            })
            .await
            .map_err(|_| err_invalid("threadChangesReview task failed."))
        }
        "ops.memoryMayGrantRemote" => {
            let client_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("clientId is required."))?
                .to_string();
            let dir = data_directory.to_path_buf();
            tokio::task::spawn_blocking(move || read_memory_may_grant_remote(&dir, &client_id))
                .await
                .map_err(|_| err_invalid("memoryMayGrantRemote task failed."))?
                .map_err(|e| SerializedEngineError::new(e, Some("unavailable")))
        }
        "ops.checkpointInspectBlobs" => {
            handle_checkpoint_inspect_blobs_rpc(args, err_invalid).await
        }
        "ops.checkpointsReadOnly" => {
            handle_checkpoints_readonly_rpc(data_directory, args, err_invalid).await
        }
        "checkpoints.list" => {
            let thread_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("threadId is required."))?
                .to_string();
            let workspace_id = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("workspaceId is required."))?
                .to_string();
            let thread_info: Option<CheckpointThreadInfo> = match args.get(2) {
                None | Some(Value::Null) => None,
                Some(v) => Some(
                    serde_json::from_value(v.clone())
                        .map_err(|_| err_invalid("threadInfo is invalid."))?,
                ),
            };
            let mut guard = Arc::clone(checkpoints).lock_owned().await;
            tokio::task::spawn_blocking(move || {
                guard.list(&thread_id, &workspace_id, thread_info.as_ref())
            })
            .await
            .map_err(|_| err_invalid("checkpoints.list task failed."))
        }
        "checkpoints.inspect" => {
            let thread_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("threadId is required."))?
                .to_string();
            let workspace_id = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("workspaceId is required."))?
                .to_string();
            let checkpoint_id = args
                .get(2)
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("checkpointId is required."))?
                .to_string();
            let thread_info: CheckpointThreadInfo = args
                .get(3)
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .ok_or_else(|| err_invalid("threadInfo is required."))?;
            let mut guard = Arc::clone(checkpoints).lock_owned().await;
            tokio::task::spawn_blocking(move || {
                guard.inspect(&thread_id, &workspace_id, &checkpoint_id, &thread_info)
            })
            .await
            .map_err(|_| err_invalid("checkpoints.inspect task failed."))
        }
        "checkpoints.beforeTurn" => {
            let thread_info: CheckpointThreadInfo = args
                .first()
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .ok_or_else(|| err_invalid("threadInfo is required."))?;
            let workspace_id = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("workspaceId is required."))?
                .to_string();
            let cwd = args
                .get(2)
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| err_invalid("workingDirectory is required."))?;
            let cwd_path = PathBuf::from(cwd);
            let mut guard = Arc::clone(checkpoints).lock_owned().await;
            let res = tokio::task::spawn_blocking(move || {
                guard.before_turn(&thread_info, &workspace_id, &cwd_path)
            })
            .await
            .map_err(|_| err_invalid("checkpoints.beforeTurn task failed."))?;
            match res {
                Ok(rec) => Ok(sotto_core::ops::tools_ok(json!({ "record": rec }))),
                Err(err) => Ok(err.to_tools_err()),
            }
        }
        "checkpoints.afterTurn" => {
            let thread_info: CheckpointThreadInfo = args
                .first()
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .ok_or_else(|| err_invalid("threadInfo is required."))?;
            let mut guard = Arc::clone(checkpoints).lock_owned().await;
            let res = tokio::task::spawn_blocking(move || guard.after_turn(&thread_info))
                .await
                .map_err(|_| err_invalid("checkpoints.afterTurn task failed."))?;
            match res {
                Ok(rec) => Ok(sotto_core::ops::tools_ok(json!({ "record": rec }))),
                Err(err) => Ok(err.to_tools_err()),
            }
        }
        "checkpoints.checkFiles" => {
            let checkpoint_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("checkpointId is required."))?
                .to_string();
            let recovery = args.get(1).and_then(Value::as_bool).unwrap_or(false);
            let mut guard = Arc::clone(checkpoints).lock_owned().await;
            let res = tokio::task::spawn_blocking(move || {
                guard
                    .ensure_loaded()
                    .map_err(|e| sotto_core::CheckpointError::new("unavailable", e))?;
                let Some(record) = guard
                    .records()
                    .iter()
                    .find(|r| r.id == checkpoint_id)
                    .cloned()
                else {
                    return Err(sotto_core::CheckpointError::new(
                        "workspace-changed",
                        "This checkpoint no longer exists.",
                    ));
                };
                guard.check_files(&record, recovery)
            })
            .await
            .map_err(|_| err_invalid("checkpoints.checkFiles task failed."))?;
            match res {
                Ok(()) => Ok(sotto_core::ops::tools_ok(json!({ "ok": true }))),
                Err(err) => Ok(err.to_tools_err()),
            }
        }
        "checkpoints.restore" => {
            let checkpoint_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("checkpointId is required."))?
                .to_string();
            let mut guard = Arc::clone(checkpoints).lock_owned().await;
            let res =
                tokio::task::spawn_blocking(move || guard.restore_checkpoint_files(&checkpoint_id))
                    .await
                    .map_err(|_| err_invalid("checkpoints.restore task failed."))?;
            match res {
                Ok(rec) => Ok(sotto_core::ops::tools_ok(json!({ "record": rec }))),
                Err(err) => Ok(err.to_tools_err()),
            }
        }
        "checkpoints.forgetThread" => {
            let thread_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("threadId is required."))?
                .to_string();
            let mut guard = Arc::clone(checkpoints).lock_owned().await;
            tokio::task::spawn_blocking(move || guard.forget_thread(&thread_id))
                .await
                .map_err(|_| err_invalid("checkpoints.forgetThread task failed."))?
                .map_err(|e| SerializedEngineError::new(e, Some("unavailable")))?;
            Ok(json!({ "ok": true }))
        }
        "checkpoints.isBlocked" => {
            let thread_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("threadId is required."))?
                .to_string();
            let mut guard = Arc::clone(checkpoints).lock_owned().await;
            let blocked = tokio::task::spawn_blocking(move || -> Result<bool, String> {
                guard.ensure_loaded()?;
                Ok(guard.is_blocked(&thread_id))
            })
            .await
            .map_err(|_| err_invalid("checkpoints.isBlocked task failed."))?
            .map_err(|e| SerializedEngineError::new(e, Some("unavailable")))?;
            Ok(json!({ "blocked": blocked }))
        }
        "checkpoints.isWorkspaceBlocked" => {
            let thread_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("threadId is required."))?
                .to_string();
            let folder = args
                .get(1)
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from);
            let mut guard = Arc::clone(checkpoints).lock_owned().await;
            let blocked = tokio::task::spawn_blocking(move || {
                guard.is_workspace_blocked(&thread_id, folder.as_deref())
            })
            .await
            .map_err(|_| err_invalid("checkpoints.isWorkspaceBlocked task failed."))?
            .map_err(|e| SerializedEngineError::new(e, Some("unavailable")))?;
            Ok(json!({ "blocked": blocked }))
        }
        "checkpoints.privacyChanged" => {
            let enabled = args.first().and_then(Value::as_bool).unwrap_or(true);
            let mut guard = Arc::clone(checkpoints).lock_owned().await;
            tokio::task::spawn_blocking(move || guard.set_history_enabled(enabled))
                .await
                .map_err(|_| err_invalid("checkpoints.privacyChanged task failed."))?
                .map_err(|e| SerializedEngineError::new(e, Some("unavailable")))?;
            Ok(json!({ "ok": true }))
        }
        "ops.tailscaleStatus" => {
            let st = probe_tailscale_status().await;
            serde_json::to_value(st).map_err(|e| SerializedEngineError::new(e.to_string(), Some("unavailable")))
        }
        "ops.phoneAccessReadOnly" => {
            let dir = data_directory.to_path_buf();
            tokio::task::spawn_blocking(move || read_phone_access_readonly(&dir))
                .await
                .map_err(|_| err_invalid("phoneAccessReadOnly task failed."))
        }
        "phones:get" => {
            let mut guard = phone_access.lock().await;
            let state = guard.get();
            serde_json::to_value(state)
                .map_err(|e| SerializedEngineError::new(e.to_string(), Some("unavailable")))
        }
        "phones:settingsChanged" => {
            let settings: PhoneAccessSettings = args
                .first()
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .ok_or_else(|| err_invalid("PhoneAccessSettings object is required."))?;
            let state = {
                let mut guard = phone_access.lock().await;
                guard.settings_changed(settings).await
            };
            let val = serde_json::to_value(&state)
                .map_err(|e| SerializedEngineError::new(e.to_string(), Some("unavailable")))?;
            shell_bridge.send_to_main("phones:changed", val.clone());
            Ok(val)
        }
        "phones:command" => {
            let cmd: PhonesCommand = args
                .first()
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .ok_or_else(|| err_invalid("PhonesCommand object is required."))?;
            let outcome = {
                let mut guard = phone_access.lock().await;
                guard
                    .command(cmd)
                    .await
                    .map_err(|e| SerializedEngineError::new(e, Some("invalid_request")))?
            };
            if let Some(url) = outcome.open_external_url {
                shell_bridge.open_external(&url).await?;
            }
            let val = serde_json::to_value(&outcome.state)
                .map_err(|e| SerializedEngineError::new(e.to_string(), Some("unavailable")))?;
            shell_bridge.send_to_main("phones:changed", val.clone());
            Ok(val)
        }
        "engine:phoneAccessPagePort" => {
            let guard = phone_access.lock().await;
            Ok(json!(guard.page_port()))
        }
        "local-apps:get" => {
            let guard = local_apps.lock().await;
            serde_json::to_value(guard.get())
                .map_err(|e| SerializedEngineError::new(e.to_string(), Some("unavailable")))
        }
        "local-apps:settingsChanged" => {
            let enabled = args
                .first()
                .and_then(|v| {
                    v.as_bool().or_else(|| {
                        v.as_object()
                            .and_then(|o| o.get("localApps"))
                            .and_then(Value::as_bool)
                    })
                })
                .ok_or_else(|| err_invalid("localApps boolean is required."))?;
            let state = {
                let mut guard = local_apps.lock().await;
                guard.settings_changed(enabled).await
            };
            let val = serde_json::to_value(&state)
                .map_err(|e| SerializedEngineError::new(e.to_string(), Some("unavailable")))?;
            shell_bridge.send_to_main("local-apps:changed", val.clone());
            Ok(val)
        }
        other => Err(SerializedEngineError {
            name: "Error".into(),
            message: format!("ENGINE_METHOD_UNHANDLED: {other}"),
            code: Some("METHOD_NOT_FOUND".into()),
        }),
    }
}

fn parse_timeout_budget(arg: Option<&Value>, default_ms: u64) -> std::time::Duration {
    let raw = arg.and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_object().and_then(|o| o.get("timeoutMs")).and_then(Value::as_u64))
    });
    let ms = raw.unwrap_or(default_ms).clamp(50, 30_000);
    std::time::Duration::from_millis(ms)
}

fn read_memory_may_grant_remote(data_directory: &Path, client_id: &str) -> Result<Value, String> {
    let db_path = data_directory.join("memory.sqlite");
    if !db_path.exists() {
        return Ok(json!({ "allowed": false }));
    }
    let store = MemoryStore::open_read_only(&db_path).map_err(|e| e.to_string())?;
    let allowed = store
        .may_grant_remote(client_id)
        .map_err(|e| e.to_string())?;
    Ok(json!({ "allowed": allowed }))
}

async fn handle_checkpoint_inspect_blobs_rpc(
    args: &[Value],
    err_invalid: impl Fn(&str) -> SerializedEngineError,
) -> Result<Value, SerializedEngineError> {
    let blobs_dir = args
        .first()
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| err_invalid("blobsDir is required."))?;
    let pairs_val = args
        .get(1)
        .ok_or_else(|| err_invalid("pairs array is required."))?;
    let pairs: Vec<CheckpointBlobPair> = serde_json::from_value(pairs_val.clone())
        .map_err(|_| err_invalid("pairs must be an array of { path, beforeHash, afterHash }."))?;
    let blobs_path = PathBuf::from(blobs_dir);
    let res = tokio::task::spawn_blocking(move || inspect_checkpoint_blobs(&blobs_path, &pairs))
        .await
        .map_err(|_| err_invalid("checkpointInspectBlobs task failed."))?;
    match res {
        Ok(patches) => Ok(sotto_core::ops::tools_ok(json!(patches))),
        Err(err) => Ok(err.to_tools_err()),
    }
}

async fn handle_checkpoints_readonly_rpc(
    data_directory: &Path,
    args: &[Value],
    err_invalid: impl Fn(&str) -> SerializedEngineError,
) -> Result<Value, SerializedEngineError> {
    let dir = args
        .first()
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| data_directory.join("checkpoints"));
    let records = tokio::task::spawn_blocking(move || read_checkpoints_readonly(&dir))
        .await
        .map_err(|_| err_invalid("checkpointsReadOnly task failed."))?
        .map_err(|e| SerializedEngineError::new(e, Some("unavailable")))?;
    Ok(json!({ "records": records }))
}

async fn handle_accelerator_rpc(
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
            "mode": "accelerator",
            "version": ENGINE_VERSION,
            "pid": std::process::id(),
        })),
        "ops.hostFacts" => {
            let running = args
                .first()
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let live = args
                .get(1)
                .and_then(|v| {
                    v.as_bool()
                        .or_else(|| v.as_object().and_then(|o| o.get("live")).and_then(Value::as_bool))
                })
                .unwrap_or(false);
            let val = tokio::task::spawn_blocking(move || {
                sotto_core::ops::host_facts_report(running, live)
            })
            .await
            .map_err(|_| err_invalid("hostFacts task failed."))?;
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
            .map_err(|_| err_invalid("threadWords task failed."))?;
            Ok(val)
        }
        "ops.gitRefsByFolder" => {
            let folder = args
                .first()
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| err_invalid("folder is required."))?
                .to_string();
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
            let refresh = opts
                .and_then(|o| o.get("refresh"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let val = tokio::task::spawn_blocking(move || {
                sotto_core::ops::git_refs_with_refresh(
                    &folder,
                    query.as_deref(),
                    cursor,
                    limit,
                    include_matching_remote,
                    refresh,
                )
            })
            .await
            .map_err(|_| err_invalid("gitRefsByFolder task failed."))?
            .map_err(|e| SerializedEngineError {
                name: "Error".into(),
                message: e,
                code: Some("unavailable".into()),
            })?;
            Ok(val)
        }
        "ops.threadFiles" => {
            let ws_val = args
                .first()
                .ok_or_else(|| err_invalid("workspace is required."))?;
            let ws: sotto_core::ops::ThreadWorkspace = serde_json::from_value(ws_val.clone())
                .map_err(|_| err_invalid("workspace must match FileWorkspace."))?;
            let rel = args
                .get(1)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let val = tokio::task::spawn_blocking(move || sotto_core::ops::thread_files(&ws, &rel))
                .await
                .map_err(|_| err_invalid("threadFiles task failed."))?;
            Ok(val)
        }
        "ops.threadFilePreview" => {
            let ws_val = args
                .first()
                .ok_or_else(|| err_invalid("workspace is required."))?;
            let ws: sotto_core::ops::ThreadWorkspace = serde_json::from_value(ws_val.clone())
                .map_err(|_| err_invalid("workspace must match FileWorkspace."))?;
            let rel = args
                .get(1)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let val = tokio::task::spawn_blocking(move || {
                sotto_core::ops::thread_file_preview(&ws, &rel)
            })
            .await
            .map_err(|_| err_invalid("threadFilePreview task failed."))?;
            Ok(val)
        }
        "ops.threadChanges" => {
            let ws_val = args
                .first()
                .ok_or_else(|| err_invalid("workspace is required."))?;
            let ws: sotto_core::ops::ThreadWorkspace = serde_json::from_value(ws_val.clone())
                .map_err(|_| err_invalid("workspace must match FileWorkspace."))?;
            let val = tokio::task::spawn_blocking(move || sotto_core::ops::thread_changes(&ws))
                .await
                .map_err(|_| err_invalid("threadChanges task failed."))?;
            Ok(val)
        }
        "ops.threadChangesReview" => {
            let ws_val = args
                .first()
                .ok_or_else(|| err_invalid("workspace is required."))?;
            let ws: sotto_core::ops::ThreadWorkspace = serde_json::from_value(ws_val.clone())
                .map_err(|_| err_invalid("workspace must match FileWorkspace."))?;
            let scope = args
                .get(1)
                .cloned()
                .unwrap_or_else(|| json!({ "kind": "working" }));
            let ignore_whitespace = args
                .get(2)
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let val = tokio::task::spawn_blocking(move || {
                sotto_core::ops::thread_changes_review(&ws, &scope, ignore_whitespace)
            })
            .await
            .map_err(|_| err_invalid("threadChangesReview task failed."))?;
            Ok(val)
        }
        "ops.usageQuery" => {
            let query = sotto_core::ops::parse_usage_read_query(args.first())
                .map_err(|e| err_invalid(&e))?;
            let dir = data_directory.to_path_buf();
            tokio::task::spawn_blocking(move || sotto_core::ops::usage_query_activity(&dir, &query))
                .await
                .map_err(|_| err_invalid("usageQuery task failed."))?
                .map_err(|e| SerializedEngineError {
                    name: "Error".into(),
                    message: e,
                    code: Some("unavailable".into()),
                })
        }
        "ops.gitChangedFiles" => {
            let folder = args
                .first()
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| err_invalid("folder is required."))?
                .to_string();
            let budget = parse_timeout_budget(args.get(1), 9_000);
            tokio::task::spawn_blocking(move || {
                sotto_core::ops::git_changed_files_with_budget(&folder, budget)
            })
            .await
            .map_err(|_| err_invalid("gitChangedFiles task failed."))?
            .map_err(|e| SerializedEngineError {
                name: "Error".into(),
                message: e,
                code: Some("unavailable".into()),
            })
        }
        "ops.memoryMayGrantRemote" => {
            let client_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| err_invalid("clientId is required."))?
                .to_string();
            let dir = data_directory.to_path_buf();
            tokio::task::spawn_blocking(move || read_memory_may_grant_remote(&dir, &client_id))
                .await
                .map_err(|_| err_invalid("memoryMayGrantRemote task failed."))?
                .map_err(|e| SerializedEngineError::new(e, Some("unavailable")))
        }
        "ops.checkpointInspectBlobs" => {
            handle_checkpoint_inspect_blobs_rpc(args, err_invalid).await
        }
        "ops.checkpointsReadOnly" => {
            handle_checkpoints_readonly_rpc(data_directory, args, err_invalid).await
        }
        "ops.tailscaleStatus" => {
            let st = probe_tailscale_status().await;
            serde_json::to_value(st)
                .map_err(|e| SerializedEngineError::new(e.to_string(), Some("unavailable")))
        }
        "ops.phoneAccessReadOnly" => {
            let dir = data_directory.to_path_buf();
            tokio::task::spawn_blocking(move || read_phone_access_readonly(&dir))
                .await
                .map_err(|_| err_invalid("phoneAccessReadOnly task failed."))
        }
        other => Err(SerializedEngineError {
            name: "Error".into(),
            message: format!("ENGINE_METHOD_UNHANDLED: {other}"),
            code: Some("METHOD_NOT_FOUND".into()),
        }),
    }
}

async fn run_accelerator(parsed: EngineCliArgs) -> ExitCode {
    // Prime the initial CPU/memory load sample on a blocking worker without starting any timer,
    // matching `HostFactsSource.primeLoad` so the first live `ops.hostFacts` query has a window.
    tokio::task::spawn_blocking(sotto_core::ops::prime_host_facts_load);

    let stream = match connect_engine_stream(&parsed.endpoint).await {
        Ok(s) => s,
        Err(err) => {
            eprintln!("Could not connect to EngineTransport endpoint: {err}");
            return ExitCode::from(1);
        }
    };

    let parts = match EngineDuplex::connect_stream(stream, Some(&parsed.token)).await {
        Ok(p) => p,
        Err(err) => {
            eprintln!("Could not send engine hello frame: {err}");
            return ExitCode::from(1);
        }
    };
    let crate::transport::EngineDuplexParts {
        duplex,
        mut incoming_rx,
        reader_task,
        mut writer_task,
    } = parts;

    let mut rpc_tasks: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();
    // Cap concurrent heavy Git/Files/Usage offloads so burst refreshes cannot starve `ops.hostFacts`
    // or `ops.threadWords`.
    let io_limiter = Arc::new(Semaphore::new(8));
    let mut shutdown_req_id: Option<u64> = None;
    let shutdown_signal = shutdown_future();
    tokio::pin!(shutdown_signal);

    loop {
        tokio::select! {
            _ = &mut shutdown_signal => {
                break;
            }
            maybe_msg = incoming_rx.recv() => {
                let Some(msg) = maybe_msg else {
                    break;
                };
                while rpc_tasks.try_join_next().is_some() {}
                if let IncomingEngineEvent::Req { id, method, args } = msg {
                    if method == "engine.shutdown" {
                        shutdown_req_id = Some(id);
                        break;
                    }
                    let data_dir = parsed.data_directory.clone();
                    let out = duplex.clone();
                    let limiter = Arc::clone(&io_limiter);
                    rpc_tasks.spawn(async move {
                        let needs_permit = matches!(
                            method.as_str(),
                            "ops.gitRefsByFolder"
                                | "ops.gitChangedFiles"
                                | "ops.threadFiles"
                                | "ops.threadFilePreview"
                                | "ops.threadChanges"
                                | "ops.threadChangesReview"
                                | "ops.usageQuery"
                                | "ops.checkpointInspectBlobs"
                        );
                        let _permit = if needs_permit {
                            limiter.acquire_owned().await.ok()
                        } else {
                            None
                        };
                        match handle_accelerator_rpc(&data_dir, &method, &args).await {
                            Ok(val) => {
                                let _ = out.send_ok(id, val);
                            }
                            Err(err) => {
                                let _ = out.send_err(id, err);
                            }
                        }
                    });
                }
            }
        }
    }

    // Drain in-flight RPCs before aborting `reader_task` so any active work completes cleanly.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while rpc_tasks.join_next().await.is_some() {}
    })
    .await;
    reader_task.abort();
    duplex.fail_pending("Engine shutting down.");
    rpc_tasks.abort_all();
    while rpc_tasks.join_next().await.is_some() {}
    if let Some(id) = shutdown_req_id {
        let _ = duplex.send_ok(id, json!({ "ok": true }));
    }
    drop(duplex);
    if tokio::time::timeout(std::time::Duration::from_secs(2), &mut writer_task)
        .await
        .is_err()
    {
        writer_task.abort();
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    if raw_args.len() == 1 && raw_args[0] == "--version" {
        println!(
            "{}",
            json!({ "runtime": "rust", "version": ENGINE_VERSION })
        );
        return ExitCode::SUCCESS;
    }
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
    let exit_code = if parsed.accelerator {
        runtime.block_on(run_accelerator(parsed))
    } else {
        runtime.block_on(run_engine(parsed))
    };
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
        host_id.clone(),
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

    let parts = match EngineDuplex::connect_stream(stream, Some(&parsed.token)).await {
        Ok(p) => p,
        Err(err) => {
            eprintln!("Could not send engine hello frame: {err}");
            coordinator.shutdown().await;
            let _ = release_host_lock(&lock_path, &lease);
            return ExitCode::from(1);
        }
    };
    let crate::transport::EngineDuplexParts {
        duplex,
        mut incoming_rx,
        reader_task,
        mut writer_task,
    } = parts;
    let shell_bridge = ShellBridgeClient::new(duplex.clone());
    let checkpoints = Arc::new(Mutex::new(CheckpointManager::new(
        parsed.data_directory.join("checkpoints"),
    )));
    let phone_access = Arc::new(Mutex::new(PhoneAccessManager::new(
        parsed.data_directory.clone(),
        host_id.clone(),
        true,
        Some(coordinator.clone()),
        Arc::new(SystemTailscaleCli::new()),
    )));
    phone_access
        .lock()
        .await
        .start(PhoneAccessSettings::default())
        .await;
    let local_apps = Arc::new(Mutex::new(LocalAppsManager::new(
        parsed.data_directory.clone(),
        host_id.clone(),
        true,
        Some(coordinator.clone()),
    )));

    let mut bcast_rx = coordinator.subscribe();
    let mut rpc_tasks: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();
    let mut shutdown_req: Option<(u64, bool)> = None;
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
                        if !duplex.send_frame(push_frame("shell", shell)) {
                            break;
                        }
                    }
                    Ok(CoordinatorBroadcast::Detail(detail)) => {
                        if let Ok(val) = serde_json::to_value(&detail) {
                            if !duplex.send_frame(push_frame("detail", val)) {
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Ok(shell) = coordinator.shell(true).await {
                            let _ = duplex.send_frame(push_frame("shell", shell));
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            maybe_msg = incoming_rx.recv() => {
                let Some(msg) = maybe_msg else {
                    break;
                };
                while rpc_tasks.try_join_next().is_some() {}
                match msg {
                    IncomingEngineEvent::Push { event, payload } => match event.as_str() {
                        "shell:credentialsSync" => {
                            if let Ok(snap) = serde_json::from_value::<CredentialSnapshot>(payload) {
                                shell_bridge.credentials().apply_snapshot(snap);
                            }
                        }
                        "engine:setWindowFocus" => {
                            if let Ok(focus) = serde_json::from_value::<EngineWindowFocus>(payload) {
                                shell_bridge.set_window_focus(focus);
                            }
                        }
                        _ => {}
                    },
                    IncomingEngineEvent::Req { id, method, args } => {
                        if method == "engine.shutdown" || method == "engine:close" {
                            shutdown_req = Some((id, method == "engine:close"));
                            break;
                        }
                        if method == "agent.command" {
                            // Enqueue coordinator commands synchronously in strict arrival order before
                            // awaiting completion asynchronously, preventing multi-thread reordering.
                            let Some(cmd) = args.first().and_then(Value::as_object) else {
                                let _ = duplex.send_err(
                                    id,
                                    SerializedEngineError {
                                        name: "Error".into(),
                                        message: "Command object is required.".into(),
                                        code: Some("invalid_request".into()),
                                    },
                                );
                                continue;
                            };
                            let local_client = ClientContext {
                                client_id: "local-desktop".into(),
                                user: "Local Desktop".into(),
                                may_answer: true,
                            };
                            match coordinator.enqueue_command(local_client, cmd.clone()) {
                                Ok(reply_rx) => {
                                    let out = duplex.clone();
                                    rpc_tasks.spawn(async move {
                                        match reply_rx.await {
                                            Ok(Ok(shell)) => {
                                                let _ = out.send_ok(id, shell);
                                            }
                                            Ok(Err(err)) => {
                                                let _ = out.send_err(id, coord_err(err));
                                            }
                                            Err(_) => {
                                                let _ = out.send_err(
                                                    id,
                                                    SerializedEngineError {
                                                        name: "Error".into(),
                                                        message: "Host coordinator stopped.".into(),
                                                        code: Some("unavailable".into()),
                                                    },
                                                );
                                            }
                                        }
                                    });
                                }
                                Err(err) => {
                                    let _ = duplex.send_err(id, coord_err(err));
                                }
                            }
                            continue;
                        }
                        let coord = coordinator.clone();
                        let bridge = shell_bridge.clone();
                        let cp_mgr = Arc::clone(&checkpoints);
                        let phone_mgr = Arc::clone(&phone_access);
                        let la_mgr = Arc::clone(&local_apps);
                        let hid = host_id.clone();
                        let data_dir = parsed.data_directory.clone();
                        let out = duplex.clone();
                        rpc_tasks.spawn(async move {
                            match handle_rpc(
                                &coord, &bridge, &cp_mgr, &phone_mgr, &la_mgr, &hid, &data_dir,
                                &method, &args,
                            )
                            .await
                            {
                                Ok(val) => {
                                    let _ = out.send_ok(id, val);
                                }
                                Err(err) => {
                                    let _ = out.send_err(id, err);
                                }
                            }
                        });
                    }
                }
            }
        }
    }

    // Drain in-flight RPCs BEFORE aborting `reader_task` so in-flight reverse-RPC calls to the
    // shell can still receive their replies during shutdown; then fail any remaining waiters.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while rpc_tasks.join_next().await.is_some() {}
    })
    .await;
    reader_task.abort();
    duplex.fail_pending("Engine shutting down.");
    rpc_tasks.abort_all();
    while rpc_tasks.join_next().await.is_some() {}
    let _ = tokio::time::timeout(std::time::Duration::from_secs(8), async {
        phone_access.lock().await.close().await;
        local_apps.lock().await.close().await;
    })
    .await;
    let shutdown_completed = tokio::time::timeout(
        std::time::Duration::from_secs(35),
        coordinator.shutdown(),
    )
    .await
    .is_ok();
    if let Some((id, is_phase2_close)) = shutdown_req {
        let frame = if shutdown_completed {
            ok_response_frame(
                id,
                if is_phase2_close {
                    json!(true)
                } else {
                    json!({ "ok": true })
                },
            )
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
        let _ = duplex.send_frame(frame);
    }
    drop(shell_bridge);
    drop(duplex);
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
