//! The commit draft on Cursor, Antigravity and OpenCode, as the fakes the Node tests use answer their side calls
//! (`tests/fixtures/fakeCursorAgent.mjs`, `tests/fixtures/fakeAntigravityAgent.mjs`, `tests/fixtures/fakeOpenCodeServer.mjs`),
//! so nothing reaches a provider or the network.

use super::*;
use crate::providers::{AcpAdapter, AcpAdapterConfig, AcpFlavor, OpenCodeAdapter, OpenCodeAdapterConfig};

const FAKE_CURSOR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/fakeCursorAgent.mjs");
const FAKE_ANTIGRAVITY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/fakeAntigravityAgent.mjs");
const FAKE_OPENCODE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/fakeOpenCodeServer.mjs");

fn folder(fixture: &Fixture) -> String {
    crate::worktree_reclaim::existing_folder(&fixture.repo.to_string_lossy()).unwrap()
}

fn assert_asked_with_the_draft(text: &str) {
    let expected = format!("{INSTRUCTION}\n\nStaged files (status and path):\nM\twork.txt\n\nStaged diff:\n");
    assert!(text.starts_with(&expected) && text.contains("+second"), "{text}");
}

fn jsonl(path: &Path) -> Vec<serde_json::Value> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------------
// Cursor.

fn cursor_on(fixture: &Fixture, runtime: &tokio::runtime::Runtime, script: serde_json::Value, config: AcpAdapterConfig) -> Arc<AcpAdapter> {
    let data = fixture.data();
    fs::create_dir_all(&data).unwrap();
    fs::write(
        data.join("cursor-threads.json"),
        json!({
            "t": { "cursorSessionId": "3d6f4ac1-4b9e-43f3-aa5e-2238e5f6c649", "cwd": fixture.repo, "modelId": "gpt-fixture" },
            "personal": { "cursorSessionId": "4e7a5bd2-5caf-4404-bb6f-3349f6a7d75a", "cwd": fixture.repo, "modelId": "gpt-fixture", "kind": "personal" },
        })
        .to_string(),
    )
    .unwrap();
    fs::write(data.join("oneshot.json"), script.to_string()).unwrap();
    let adapter = Arc::new(AcpAdapter::new(config));
    let (events, _) = tokio::sync::mpsc::unbounded_channel();
    runtime.block_on(adapter.connect(events)).unwrap();
    assert_eq!(adapter.status().connection, "connected");
    adapter
}

fn cursor(fixture: &Fixture, runtime: &tokio::runtime::Runtime, script: serde_json::Value, deadline: Duration) -> Arc<AcpAdapter> {
    let mut config = AcpAdapterConfig::fake(AcpFlavor::Cursor, fixture.data(), FAKE_CURSOR.into());
    config.side_writing_deadline = deadline;
    cursor_on(fixture, runtime, script, config)
}

#[test]
fn cursor_drafts_the_commit_in_ask_mode_with_side_config_and_least_effort() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let adapter = cursor(&fixture, &runtime, json!({ "text": "Fix the parser.\n\nBecause it broke." }), Duration::from_secs(60));
    // Catalog also exposes Cursor's efforts in Sotto's order.
    let gpt = adapter.models().into_iter().find(|m| m.id.ends_with(":gpt-fixture")).unwrap();
    assert_eq!(gpt.reasoning_efforts.as_deref(), Some(&["none".to_string(), "low".into(), "medium".into(), "high".into()][..]));

    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), "Fix the parser\nBecause it broke.");

    let calls = oneshots(&fixture);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["model"], json!("gpt-fixture"));
    assert_eq!(calls[0]["effort"], json!("none"));
    assert_eq!(calls[0]["mode"], json!("ask"));
    assert_eq!(calls[0]["cwd"].as_str().unwrap().to_lowercase(), folder(&fixture).to_lowercase());
    assert_asked_with_the_draft(calls[0]["material"].as_str().unwrap());

    let side_cfg: serde_json::Value = serde_json::from_str(&fs::read_to_string(fixture.data().join("cursor").join("side-config").join("cli-config.json")).unwrap()).unwrap();
    assert_eq!(side_cfg["permissions"]["allow"], json!([]));
    assert_eq!(side_cfg["permissions"]["deny"], json!(crate::providers::acp_side::CURSOR_SIDE_DENY));
    assert_eq!(side_cfg["approvalMode"], json!("allowlist"));
    assert!(!fixture.data().join("violations.jsonl").exists(), "Cursor side call recorded a protocol violation");
}

#[test]
fn cursor_that_fails_tries_a_tool_or_outlasts_the_deadline_leaves_nodes_stand_in_subject() {
    let runtime = runtime();
    let fixture = Fixture::new();
    let adapter = cursor(&fixture, &runtime, json!({ "fail": true }), Duration::from_secs(60));
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), STAND_IN_SUBJECT);

    let fixture = Fixture::new();
    let adapter = cursor(&fixture, &runtime, json!({ "tool": true, "text": "Not kept" }), Duration::from_secs(60));
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), STAND_IN_SUBJECT);
    let cancels = jsonl(&fixture.data().join("oneshot-cancels.jsonl"));
    assert_eq!(cancels.len(), 1, "expected session/cancel after tool_call");
    assert_eq!(
        Path::new(cancels[0]["configDirectory"].as_str().unwrap()),
        fixture.data().join("cursor").join("side-config")
    );

    let fixture = Fixture::new();
    let adapter = cursor(&fixture, &runtime, json!({ "delayMs": 30_000, "text": "Too late" }), Duration::from_millis(1_500));
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), STAND_IN_SUBJECT);
}

#[test]
fn cursor_writes_nothing_for_a_personal_thread_missing_record_or_while_disconnected() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let adapter = cursor(&fixture, &runtime, json!({ "text": "Unused" }), Duration::from_secs(60));
    let prompt = commit_message_request(&material(), &WritingSettings::default()).prompt;
    for thread in ["other", "personal"] {
        assert_eq!(runtime.block_on(adapter.write_short_text(thread.into(), prompt.clone())), Ok(None), "{thread}");
    }
    runtime.block_on(adapter.disconnect()).unwrap();
    assert_eq!(runtime.block_on(adapter.write_short_text("t".into(), prompt)), Ok(None));
    assert!(oneshots(&fixture).is_empty());
}

#[test]
fn cursor_session_and_side_call_start_on_nodes_allow_listed_environment() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let recorder = fixture.dir.path().join("record-cursor-env.mjs");
    let script = format!(
        "import {{ appendFileSync }} from 'node:fs'\nimport {{ join }} from 'node:path'\nimport {{ pathToFileURL }} from 'node:url'\nconst root = process.argv[2]\nconst keys = Object.keys(process.env).filter(k => !k.startsWith('=')).map(k => k.toLowerCase()).sort()\nappendFileSync(join(root, 'cursor-envs.jsonl'), JSON.stringify({{ configDir: process.env.CURSOR_CONFIG_DIR, keys }}) + '\\n')\nawait import(pathToFileURL({}).href)\n",
        serde_json::to_string(FAKE_CURSOR).unwrap()
    );
    fs::write(&recorder, script).unwrap();

    let mut config = AcpAdapterConfig::fake(AcpFlavor::Cursor, fixture.data(), FAKE_CURSOR.into());
    config.prefix_args[0] = recorder.to_string_lossy().into_owned();
    let adapter = cursor_on(&fixture, &runtime, json!({ "text": "Fix the parser" }), config);
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), "Fix the parser");

    let recorded = jsonl(&fixture.data().join("cursor-envs.jsonl"));
    assert!(recorded.len() >= 2, "{recorded:?}");
    let extra = ["cursor_config_dir", "cursor_invoked_as", "no_open_browser"];
    for entry in &recorded {
        let keys: Vec<&str> = entry["keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap())
            .filter(|k| *k != "__cf_user_text_encoding")
            .collect();
        for flag in extra {
            assert!(keys.contains(&flag), "{flag} missing from {keys:?}");
        }
        for key in &keys {
            assert!(
                crate::providers::acp_side::CURSOR_ENVIRONMENT_KEYS.contains(key) || extra.contains(key),
                "{key} is not in Node's cursorEnvironment"
            );
        }
    }
    let side_dir = fixture.data().join("cursor").join("side-config");
    assert!(recorded.iter().any(|entry| Path::new(entry["configDir"].as_str().unwrap()) == side_dir));
}

#[test]
fn cursor_drafts_on_the_model_configured_while_idle() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let adapter = cursor(&fixture, &runtime, json!({ "text": "Fix the parser" }), Duration::from_secs(60));
    // Thread `t` starts on `gpt-fixture` with no live thread process; switching via `configure_thread` must persist
    // so the next commit draft runs on `claude-fixture` and its least effort (`low`).
    runtime
        .block_on(adapter.configure_thread("t".into(), Some("claude-fixture".into()), None, Some("max".into())))
        .unwrap();
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), "Fix the parser");
    let calls = oneshots(&fixture);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["model"], json!("claude-fixture"));
    assert_eq!(calls[0]["effort"], json!("low"));
    let saved: serde_json::Value = serde_json::from_str(&fs::read_to_string(fixture.data().join("cursor-threads.json")).unwrap()).unwrap();
    assert_eq!(saved["t"]["modelId"], json!("claude-fixture"));
    assert_eq!(saved["t"]["reasoningEffort"], json!("max"));
}

#[test]
fn cursor_send_message_applies_per_model_effort_option_and_rejects_unknown_effort() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let adapter = cursor(&fixture, &runtime, json!({ "text": "Fix the parser" }), Duration::from_secs(60));
    let send = crate::provider::SendMessageRequest {
        thread_id: "t-effort".into(),
        record_seed: crate::provider::ThreadRecordSeed { project_id: "project-1".into(), title: "Effort check".into(), created_at: "2026-11-27T10:00:00.000Z".into() },
        message_id: "m-1".into(),
        cwd: fixture.repo.to_string_lossy().into_owned(),
        model_id: Some("native:cursor:model:gpt-fixture".into()),
        reasoning_effort: Some("high".into()),
        runtime_mode: Some("approval-required".into()),
        text: "Hello".into(),
        command_id: "c-1".into(),
        draft_id: "d-1".into(),
        attachments: Vec::new(),
    };
    runtime.block_on(adapter.send_message(send)).unwrap();

    // Wire must have sent Cursor's per-model `reasoning` configId (not hardcoded `reasoning_effort`) and fake session saved `high`.
    let frames = jsonl(&fixture.data().join("requests.jsonl"));
    let effort_call = frames
        .iter()
        .find(|f| f["method"] == "session/set_config_option" && f["params"]["configId"] == "reasoning");
    assert!(effort_call.is_some(), "expected configId=reasoning in {frames:?}");
    assert_eq!(effort_call.unwrap()["params"]["value"], json!("high"));
    assert!(!frames.iter().any(|f| f["params"]["configId"] == "reasoning_effort"));

    let saved: serde_json::Value = serde_json::from_str(&fs::read_to_string(fixture.data().join("cursor-threads.json")).unwrap()).unwrap();
    assert_eq!(saved["t-effort"]["reasoningEffort"], json!("high"));
    let sid = saved["t-effort"]["cursorSessionId"].as_str().unwrap();
    let fake_session: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(fixture.data().join("sessions").join(format!("{sid}.json"))).unwrap()).unwrap();
    assert_eq!(fake_session["effort"], json!("high"));

    // Switching to `claude-fixture` must use its own per-model option ID (`effort`) rather than `reasoning`.
    runtime
        .block_on(adapter.configure_thread(
            "t-effort".into(),
            Some("native:cursor:model:claude-fixture".into()),
            None,
            Some("max".into()),
        ))
        .unwrap();
    let frames_after = jsonl(&fixture.data().join("requests.jsonl"));
    assert!(
        frames_after
            .iter()
            .any(|f| f["method"] == "session/set_config_option" && f["params"]["configId"] == "effort" && f["params"]["value"] == "max"),
        "expected configId=effort for claude-fixture in {frames_after:?}"
    );
    let fake_session_after: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(fixture.data().join("sessions").join(format!("{sid}.json"))).unwrap()).unwrap();
    assert_eq!(fake_session_after["effort"], json!("max"));

    // An invalid effort must fail rather than being swallowed and persisted.
    let err = runtime.block_on(adapter.configure_thread(
        "t-effort".into(),
        Some("native:cursor:model:claude-fixture".into()),
        None,
        Some("ultra".into()),
    ));
    assert!(err.is_err(), "expected unknown effort to fail");
    let saved_after: serde_json::Value = serde_json::from_str(&fs::read_to_string(fixture.data().join("cursor-threads.json")).unwrap()).unwrap();
    assert_eq!(saved_after["t-effort"]["reasoningEffort"], json!("max"));

    runtime.block_on(adapter.disconnect()).unwrap();
}

#[test]
fn cursor_ignores_pre_session_inbound_request_while_antigravity_aborts() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let cursor_pinger = fixture.dir.path().join("cursor-pre-session-ping.mjs");
    // Sends a server-initiated request before replying to `initialize`, then forwards to `fakeCursorAgent.mjs`.
    let script = format!(
        "import {{ createInterface }} from 'node:readline'\nimport {{ spawn }} from 'node:child_process'\nconst child = spawn(process.execPath, [{}, ...process.argv.slice(2)], {{ stdio: ['pipe', 'pipe', 'pipe'] }})\nchild.stderr.pipe(process.stderr)\nlet pinged = false\ncreateInterface({{ input: process.stdin }}).on('line', line => {{\n  const msg = JSON.parse(line)\n  if (msg.id === 'pre-1') return\n  if (msg.method === 'initialize' && !pinged) {{ pinged = true; process.stdout.write(JSON.stringify({{ jsonrpc: '2.0', id: 'pre-1', method: 'cursor/ping', params: {{}} }}) + '\\n') }}\n  child.stdin.write(line + '\\n')\n}}).on('close', () => child.stdin.end())\nchild.stdout.pipe(process.stdout)\nchild.on('exit', code => process.exit(code ?? 0))\n",
        serde_json::to_string(FAKE_CURSOR).unwrap()
    );
    fs::write(&cursor_pinger, script).unwrap();
    let mut cfg = AcpAdapterConfig::fake(AcpFlavor::Cursor, fixture.data(), FAKE_CURSOR.into());
    cfg.prefix_args[0] = cursor_pinger.to_string_lossy().into_owned();
    let adapter = cursor_on(&fixture, &runtime, json!({ "text": "Fix the parser" }), cfg);
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), "Fix the parser");

    // Antigravity aborts on any inbound request, even before `session/new` returns.
    let agy_fixture = Fixture::new();
    let agy_pinger = agy_fixture.dir.path().join("agy-pre-session-ping.mjs");
    let agy_script = format!(
        "import {{ createInterface }} from 'node:readline'\nimport {{ spawn }} from 'node:child_process'\nconst child = spawn(process.execPath, [{}, ...process.argv.slice(2)], {{ stdio: ['pipe', 'pipe', 'pipe'] }})\nchild.stderr.pipe(process.stderr)\nlet pinged = false\ncreateInterface({{ input: process.stdin }}).on('line', line => {{\n  const msg = JSON.parse(line)\n  if (msg.id === 'pre-1') return\n  if (msg.method === 'initialize' && !pinged) {{ pinged = true; process.stdout.write(JSON.stringify({{ jsonrpc: '2.0', id: 'pre-1', method: 'antigravity/ping', params: {{}} }}) + '\\n') }}\n  child.stdin.write(line + '\\n')\n}}).on('close', () => child.stdin.end())\nchild.stdout.pipe(process.stdout)\nchild.on('exit', code => process.exit(code ?? 0))\n",
        serde_json::to_string(FAKE_ANTIGRAVITY).unwrap()
    );
    fs::write(&agy_pinger, agy_script).unwrap();
    let mut agy_cfg = AcpAdapterConfig::fake(AcpFlavor::Antigravity, agy_fixture.data(), FAKE_ANTIGRAVITY.into());
    agy_cfg.prefix_args[0] = agy_pinger.to_string_lossy().into_owned();
    let agy_adapter = antigravity_on(&agy_fixture, &runtime, "gemini-3.8-flash", json!({ "text": "Should be dropped" }), agy_cfg);
    commit(&agy_fixture, &drafting(&agy_fixture, &runtime, agy_adapter, false), None);
    assert_eq!(agy_fixture.last_commit(), STAND_IN_SUBJECT);
}

// ---------------------------------------------------------------------------------------------------------------------
// Antigravity.

fn antigravity_on(fixture: &Fixture, runtime: &tokio::runtime::Runtime, model: &str, script: serde_json::Value, config: AcpAdapterConfig) -> Arc<AcpAdapter> {
    let data = fixture.data();
    fs::create_dir_all(&data).unwrap();
    fs::write(
        data.join("antigravity-threads.json"),
        json!({
            "t": { "antigravitySessionId": "3d6f4ac1-4b9e-43f3-aa5e-2238e5f6c649", "cwd": fixture.repo, "modelId": model },
            "personal": { "antigravitySessionId": "4e7a5bd2-5caf-4404-bb6f-3349f6a7d75a", "cwd": fixture.repo, "modelId": model, "kind": "personal" },
        })
        .to_string(),
    )
    .unwrap();
    fs::write(data.join("oneshot.json"), script.to_string()).unwrap();
    let adapter = Arc::new(AcpAdapter::new(config));
    let (events, _) = tokio::sync::mpsc::unbounded_channel();
    runtime.block_on(adapter.connect(events)).unwrap();
    assert_eq!(adapter.status().connection, "connected");
    adapter
}

fn antigravity(fixture: &Fixture, runtime: &tokio::runtime::Runtime, model: &str, script: serde_json::Value, deadline: Duration) -> Arc<AcpAdapter> {
    let mut config = AcpAdapterConfig::fake(AcpFlavor::Antigravity, fixture.data(), FAKE_ANTIGRAVITY.into());
    config.side_writing_deadline = deadline;
    antigravity_on(fixture, runtime, model, script, config)
}

#[test]
fn antigravity_drafts_the_commit_on_a_gemini_model_at_least_thinking_and_removes_scratch_files() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let adapter = antigravity(
        &fixture,
        &runtime,
        "gemini-4-carbon",
        json!({ "text": "Fix the parser.\n\nBecause it broke.", "writeFiles": true }),
        Duration::from_secs(60),
    );
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), "Fix the parser\nBecause it broke.");

    let calls = oneshots(&fixture);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["model"], json!("gemini-4-carbon"));
    assert_eq!(calls[0]["thinking"], json!("low"));
    assert_eq!(calls[0]["mode"], json!("default"));
    assert_eq!(calls[0]["cwd"].as_str().unwrap().to_lowercase(), folder(&fixture).to_lowercase());
    assert_asked_with_the_draft(calls[0]["material"].as_str().unwrap());

    let sid = calls[0]["sessionId"].as_str().unwrap();
    let app_data = fixture.data().join("antigravity").join("gemini").join("antigravity-acp");
    assert!(!app_data.join("brain").join(sid).exists(), "side session brain folder was left behind");
    assert!(!app_data.join("conversations").join(format!("{sid}.db")).exists(), "side session db was left behind");
    assert!(!app_data.join("conversations").join(format!("{sid}.db-wal")).exists(), "side session wal was left behind");
    assert!(!fixture.data().join("violations.jsonl").exists(), "Antigravity side call recorded a violation");
}

#[test]
fn antigravity_refuses_non_gemini_models_and_leaves_stand_in_subject() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let adapter = antigravity(&fixture, &runtime, "claude-sonnet-5-5", json!({ "text": "Not allowed" }), Duration::from_secs(60));
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), STAND_IN_SUBJECT);
    assert!(oneshots(&fixture).is_empty());
}

#[test]
fn antigravity_that_fails_tries_a_tool_or_outlasts_the_deadline_leaves_nodes_stand_in_subject() {
    let runtime = runtime();
    for script in [
        json!({ "fail": true, "writeFiles": true }),
        json!({ "tool": true, "text": "Not kept", "writeFiles": true }),
    ] {
        let fixture = Fixture::new();
        let adapter = antigravity(&fixture, &runtime, "gemini-3.8-flash", script.clone(), Duration::from_secs(60));
        commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
        assert_eq!(fixture.last_commit(), STAND_IN_SUBJECT, "{script}");
        let calls = oneshots(&fixture);
        assert_eq!(calls.len(), 1);
        let sid = calls[0]["sessionId"].as_str().unwrap();
        let app_data = fixture.data().join("antigravity").join("gemini").join("antigravity-acp");
        assert!(!app_data.join("brain").join(sid).exists());
        assert!(!app_data.join("conversations").join(format!("{sid}.db")).exists());
    }

    let fixture = Fixture::new();
    let adapter = antigravity(
        &fixture,
        &runtime,
        "gemini-3.8-flash",
        json!({ "delayMs": 30_000, "text": "Too late", "writeFiles": true }),
        Duration::from_millis(1_500),
    );
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), STAND_IN_SUBJECT);
    let calls = oneshots(&fixture);
    if let Some(sid) = calls.first().and_then(|c| c["sessionId"].as_str()) {
        let app_data = fixture.data().join("antigravity").join("gemini").join("antigravity-acp");
        assert!(!app_data.join("brain").join(sid).exists());
        assert!(!app_data.join("conversations").join(format!("{sid}.db")).exists());
    }
}

#[test]
fn cancelling_an_antigravity_side_call_still_removes_its_scratch_session_files() {
    let runtime = runtime();
    let fixture = Fixture::new();
    let adapter = antigravity(
        &fixture,
        &runtime,
        "gemini-3.8-flash",
        json!({ "delayMs": 30_000, "text": "Too late", "writeFiles": true }),
        Duration::from_secs(60),
    );
    let prompt = commit_message_request(&material(), &WritingSettings::default()).prompt;

    let session_id = runtime.block_on(async {
        let mut call = std::pin::pin!(adapter.write_short_text("t".into(), prompt));
        let wait_written = async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            while tokio::time::Instant::now() < deadline {
                let calls = oneshots(&fixture);
                if let Some(sid) = calls.first().and_then(|c| c["sessionId"].as_str()).map(String::from) {
                    return Some(sid);
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            None
        };
        tokio::select! {
            _ = &mut call => None,
            sid = wait_written => sid,
        }
    });
    let sid = session_id.expect("expected Antigravity side session files to be created before cancel");
    let app_data = fixture.data().join("antigravity").join("gemini").join("antigravity-acp");
    runtime.block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while tokio::time::Instant::now() < deadline
            && (app_data.join("brain").join(&sid).exists() || app_data.join("conversations").join(format!("{sid}.db")).exists())
        {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });
    assert!(!app_data.join("brain").join(&sid).exists(), "brain folder survived cancel");
    assert!(!app_data.join("conversations").join(format!("{sid}.db")).exists(), "conversation db survived cancel");
}

#[test]
fn antigravity_writes_nothing_for_a_personal_thread_missing_record_or_while_disconnected() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let adapter = antigravity(&fixture, &runtime, "gemini-3.8-flash", json!({ "text": "Unused" }), Duration::from_secs(60));
    let prompt = commit_message_request(&material(), &WritingSettings::default()).prompt;
    for thread in ["other", "personal"] {
        assert_eq!(runtime.block_on(adapter.write_short_text(thread.into(), prompt.clone())), Ok(None), "{thread}");
    }
    runtime.block_on(adapter.disconnect()).unwrap();
    assert_eq!(runtime.block_on(adapter.write_short_text("t".into(), prompt)), Ok(None));
    assert!(oneshots(&fixture).is_empty());
}

#[test]
fn antigravity_session_and_side_call_start_on_nodes_allow_listed_environment() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let recorder = fixture.dir.path().join("record-agy-env.mjs");
    let script = format!(
        "import {{ appendFileSync }} from 'node:fs'\nimport {{ join }} from 'node:path'\nimport {{ pathToFileURL }} from 'node:url'\nconst root = process.argv[2]\nconst keys = Object.keys(process.env).filter(k => !k.startsWith('=')).map(k => k.toLowerCase()).sort()\nappendFileSync(join(root, 'agy-envs.jsonl'), JSON.stringify({{ geminiHome: process.env.GEMINI_HOME, keys }}) + '\\n')\nawait import(pathToFileURL({}).href)\n",
        serde_json::to_string(FAKE_ANTIGRAVITY).unwrap()
    );
    fs::write(&recorder, script).unwrap();

    let mut config = AcpAdapterConfig::fake(AcpFlavor::Antigravity, fixture.data(), FAKE_ANTIGRAVITY.into());
    config.prefix_args[0] = recorder.to_string_lossy().into_owned();
    let adapter = antigravity_on(&fixture, &runtime, "gemini-3.8-flash", json!({ "text": "Fix the parser" }), config);
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), "Fix the parser");

    let recorded = jsonl(&fixture.data().join("agy-envs.jsonl"));
    assert!(recorded.len() >= 2, "{recorded:?}");
    let extra = [
        "gemini_home",
        "agy_acp_force_file_storage",
        "agy_cli_disable_auto_update",
        "pythonunbuffered",
        "ssh_connection",
        "temp",
        "tmp",
        "tmpdir",
    ];
    for entry in &recorded {
        let keys: Vec<&str> = entry["keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap())
            .filter(|k| *k != "__cf_user_text_encoding")
            .collect();
        for required in ["gemini_home", "agy_acp_force_file_storage", "agy_cli_disable_auto_update", "pythonunbuffered", "ssh_connection"] {
            assert!(keys.contains(&required), "{required} missing from {keys:?}");
        }
        for forbidden in ["gemini_api_key", "google_api_key", "google_application_credentials", "browser"] {
            assert!(!keys.contains(&forbidden), "{forbidden} leaked into Antigravity env: {keys:?}");
        }
        for key in &keys {
            assert!(
                crate::providers::acp_side::ANTIGRAVITY_ENVIRONMENT_KEYS.contains(key) || extra.contains(key),
                "{key} is not in Node's antigravityEnvironment"
            );
        }
    }
}

#[test]
fn antigravity_drafts_on_the_model_configured_while_idle() {
    let fixture = Fixture::new();
    let runtime = runtime();
    // Start on a non-Gemini model, then switch to `gemini-4-carbon` while idle before drafting.
    let adapter = antigravity(&fixture, &runtime, "claude-sonnet-5-5", json!({ "text": "Fix the parser" }), Duration::from_secs(60));
    runtime
        .block_on(adapter.configure_thread("t".into(), Some("gemini-4-carbon".into()), None, Some("high".into())))
        .unwrap();
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), "Fix the parser");
    let calls = oneshots(&fixture);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["model"], json!("gemini-4-carbon"));
    assert_eq!(calls[0]["thinking"], json!("low"));
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenCode.

fn opencode(fixture: &Fixture, runtime: &tokio::runtime::Runtime, model: &str, confirmed: bool, script: serde_json::Value, deadline: Duration) -> Arc<OpenCodeAdapter> {
    let data = fixture.data();
    fs::create_dir_all(&data).unwrap();
    fs::write(
        data.join("opencode-threads.json"),
        json!({
            "t": {
                "sessionId": "ses_fixture_1",
                "cwd": fixture.repo,
                "modelId": model,
                "sessionConfirmed": confirmed,
                "createToken": "tok-1",
            },
        })
        .to_string(),
    )
    .unwrap();
    fs::write(data.join("script.json"), script.to_string()).unwrap();
    let mut config = OpenCodeAdapterConfig::fake(data, FAKE_OPENCODE.into());
    config.side_writing_deadline = deadline;
    let adapter = Arc::new(OpenCodeAdapter::new(config));
    let (events, _) = tokio::sync::mpsc::unbounded_channel();
    runtime.block_on(adapter.connect(events)).unwrap();
    assert_eq!(adapter.status().connection, "connected");
    adapter
}

#[test]
fn opencode_drafts_the_commit_via_experimental_generate_at_least_effort_whatever_order_variants_arrive() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let script = json!({
        "migrationMs": 1,
        "models": [
            {
                "id": "fixture-model",
                "modelID": "fixture-model",
                "providerID": "opencode",
                "name": "Fixture Model",
                "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
                "variants": [{ "id": "high" }, { "id": "medium" }, { "id": "low" }],
                "enabled": true,
                "status": "active"
            }
        ],
        "generate": { "text": "Fix the parser.\n\nBecause it broke." }
    });
    let adapter = opencode(&fixture, &runtime, "opencode/fixture-model", true, script, Duration::from_secs(60));
    commit(&fixture, &drafting(&fixture, &runtime, Arc::clone(&adapter) as Arc<dyn ProviderAdapter>, false), None);
    assert_eq!(fixture.last_commit(), "Fix the parser\nBecause it broke.");

    let calls = jsonl(&fixture.data().join("side-calls.jsonl"));
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["model"], json!({ "providerID": "opencode", "id": "fixture-model", "variant": "low" }));
    assert_asked_with_the_draft(calls[0]["prompt"].as_str().unwrap());
    assert!(!fixture.data().join("violations.jsonl").exists());

    runtime.block_on(adapter.disconnect()).unwrap();
}

#[test]
fn opencode_maps_off_effort_to_none_and_omits_variant_when_model_has_none() {
    let runtime = runtime();
    let fixture = Fixture::new();
    let script = json!({
        "migrationMs": 1,
        "models": [
            {
                "id": "off-model",
                "modelID": "off-model",
                "providerID": "opencode",
                "name": "Off Model",
                "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
                "variants": [{ "id": "high" }, { "id": "off" }],
                "enabled": true,
                "status": "active"
            }
        ],
        "generate": { "text": "Use none variant" }
    });
    let adapter = opencode(&fixture, &runtime, "opencode/off-model", true, script, Duration::from_secs(60));
    commit(&fixture, &drafting(&fixture, &runtime, Arc::clone(&adapter) as Arc<dyn ProviderAdapter>, false), None);
    assert_eq!(fixture.last_commit(), "Use none variant");
    let calls = jsonl(&fixture.data().join("side-calls.jsonl"));
    assert_eq!(calls[0]["model"], json!({ "providerID": "opencode", "id": "off-model", "variant": "none" }));
    runtime.block_on(adapter.disconnect()).unwrap();

    let fixture = Fixture::new();
    let script = json!({ "migrationMs": 1, "generate": { "text": "No variant" } });
    let adapter = opencode(&fixture, &runtime, "opencode/text-only", true, script, Duration::from_secs(60));
    commit(&fixture, &drafting(&fixture, &runtime, Arc::clone(&adapter) as Arc<dyn ProviderAdapter>, false), None);
    assert_eq!(fixture.last_commit(), "No variant");
    let calls = jsonl(&fixture.data().join("side-calls.jsonl"));
    assert_eq!(calls[0]["model"], json!({ "providerID": "opencode", "id": "text-only" }));
    runtime.block_on(adapter.disconnect()).unwrap();
}

#[test]
fn opencode_refusal_new_unmarked_session_or_timeout_leaves_nodes_stand_in_subject() {
    let runtime = runtime();
    for script in [
        json!({ "migrationMs": 1, "generate": { "refuse": "zen" } }),
        json!({ "migrationMs": 1, "generate": { "session": true, "text": "Should not be kept" } }),
    ] {
        let fixture = Fixture::new();
        let adapter = opencode(&fixture, &runtime, "opencode/fixture-model", true, script.clone(), Duration::from_secs(60));
        commit(&fixture, &drafting(&fixture, &runtime, Arc::clone(&adapter) as Arc<dyn ProviderAdapter>, false), None);
        assert_eq!(fixture.last_commit(), STAND_IN_SUBJECT, "{script}");
        runtime.block_on(adapter.disconnect()).unwrap();
    }

    let fixture = Fixture::new();
    let script = json!({
        "migrationMs": 1,
        "delay": { "experimental.generate.text": 30_000 },
        "generate": { "text": "Too late" }
    });
    let adapter = opencode(&fixture, &runtime, "opencode/fixture-model", true, script, Duration::from_millis(1_500));
    commit(&fixture, &drafting(&fixture, &runtime, Arc::clone(&adapter) as Arc<dyn ProviderAdapter>, false), None);
    assert_eq!(fixture.last_commit(), STAND_IN_SUBJECT);
    runtime.block_on(adapter.disconnect()).unwrap();
}

#[test]
fn opencode_writes_nothing_for_unconfirmed_session_missing_record_or_while_disconnected() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let adapter = opencode(&fixture, &runtime, "opencode/fixture-model", false, json!({ "migrationMs": 1 }), Duration::from_secs(60));
    let prompt = commit_message_request(&material(), &WritingSettings::default()).prompt;
    assert_eq!(runtime.block_on(adapter.write_short_text("t".into(), prompt.clone())), Ok(None));
    assert_eq!(runtime.block_on(adapter.write_short_text("other".into(), prompt.clone())), Ok(None));
    runtime.block_on(adapter.disconnect()).unwrap();
    assert_eq!(runtime.block_on(adapter.write_short_text("t".into(), prompt)), Ok(None));
    assert!(jsonl(&fixture.data().join("side-calls.jsonl")).is_empty());
}

#[test]
fn opencode_drafts_on_a_configured_model_omits_default_variant_and_ignores_marked_sotto_sessions() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let script = json!({
        "migrationMs": 1,
        "models": [
            {
                "id": "fixture-model",
                "modelID": "fixture-model",
                "providerID": "opencode",
                "name": "Fixture Model",
                "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
                "variants": [{ "id": "low" }, { "id": "high" }],
                "enabled": true,
                "status": "active"
            },
            {
                "id": "default-only",
                "modelID": "default-only",
                "providerID": "opencode",
                "name": "Default Only",
                "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
                "variants": [{ "id": "default" }],
                "enabled": true,
                "status": "active"
            }
        ],
        "generate": { "text": "Marked sessions stay ignored" }
    });
    let adapter = opencode(&fixture, &runtime, "opencode/fixture-model", true, script, Duration::from_secs(60));
    // Create a real Rust-created session using TypeScript's percent-encoded public model IDs
    // (`native:opencode:model:opencode%2F...`), switch its model via `configure_thread` to `opencode/default-only`,
    // and verify drafting uses the new model without `variant`.
    assert!(adapter
        .models()
        .iter()
        .any(|m| m.id == "native:opencode:model:opencode%2Ffixture-model"));
    let send = crate::provider::SendMessageRequest {
        thread_id: "t-created".into(),
        record_seed: crate::provider::ThreadRecordSeed { project_id: "project-1".into(), title: "Fix the build".into(), created_at: "2026-11-27T10:00:00.000Z".into() },
        message_id: "m-1".into(),
        cwd: fixture.repo.to_string_lossy().into_owned(),
        model_id: Some("native:opencode:model:opencode%2Ffixture-model".into()),
        reasoning_effort: Some("high".into()),
        runtime_mode: Some("approval-required".into()),
        text: "Hello".into(),
        command_id: "c-1".into(),
        draft_id: "d-1".into(),
        attachments: Vec::new(),
    };
    runtime.block_on(adapter.send_message(send)).unwrap();
    runtime
        .block_on(adapter.configure_thread(
            "t-created".into(),
            Some("native:opencode:model:opencode%2Fdefault-only".into()),
            None,
            None,
        ))
        .unwrap();

    // Verify `session.create` sent `metadata.sotto.thread` and `model.id`.
    let reqs = jsonl(&fixture.data().join("requests.jsonl"));
    let created = reqs.iter().find(|r| r["method"] == "session.create").unwrap();
    assert!(created["params"]["metadata"]["sotto"]["thread"].as_str().is_some(), "missing CREATE_MARK in {created}");
    assert_eq!(created["params"]["model"]["id"], json!("fixture-model"));

    let prompt = commit_message_request(&material(), &WritingSettings::default()).prompt;
    let drafted = runtime.block_on(adapter.write_short_text("t-created".into(), prompt)).unwrap();
    assert_eq!(drafted.as_deref(), Some("Marked sessions stay ignored"));

    let calls = jsonl(&fixture.data().join("side-calls.jsonl"));
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["model"], json!({ "providerID": "opencode", "id": "default-only" }));
    assert!(!fixture.data().join("violations.jsonl").exists());

    runtime.block_on(adapter.disconnect()).unwrap();
}
