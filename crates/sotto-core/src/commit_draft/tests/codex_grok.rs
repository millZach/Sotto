//! The commit draft on Codex and Grok Build, as the fakes the Node tests use answer their side calls
//! (`tests/fixtures/fakeCodexAppServer.mjs`, `tests/fixtures/fakeGrokThreadAgent.mjs`), so nothing reaches a provider or
//! the network.

use super::*;
use crate::providers::{AcpAdapter, AcpAdapterConfig, AcpFlavor, CodexAdapter, CodexAdapterConfig};

const FAKE_CODEX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/fakeCodexAppServer.mjs");
const FAKE_GROK: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/fakeGrokThreadAgent.mjs");
const FAKE_DEVIN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/fakeDevinAgent.mjs");

/// The fixture's repository as Node's `existingWorkingDirectory` gives it to the client, lowercased for Windows.
fn folder(fixture: &Fixture) -> String {
    crate::worktree_reclaim::existing_folder(&fixture.repo.to_string_lossy()).unwrap()
}

/// What the fake was handed on its input, as the side call's material should start.
fn assert_asked_with_the_draft(text: &str) {
    let expected = format!("{INSTRUCTION}\n\nStaged files (status and path):\nM\twork.txt\n\nStaged diff:\n");
    assert!(text.starts_with(&expected) && text.contains("+second"), "{text}");
}

/// The names in the environment of each process a recorder saw, the side call's apart from the sessions'. The macOS
/// text encoding every process is given however its environment was cleared is left out.
fn environments(fixture: &Fixture) -> (Vec<Vec<String>>, Vec<Vec<String>>) {
    let recorded: Vec<serde_json::Value> =
        fs::read_to_string(fixture.data().join("environments.jsonl")).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let keys = |entry: &serde_json::Value| -> Vec<String> {
        entry["keys"].as_array().unwrap().iter().map(|key| key.as_str().unwrap().to_string()).filter(|key| key != "__cf_user_text_encoding").collect()
    };
    let sessions = recorded.iter().filter(|entry| entry["side"] == false).map(keys).collect();
    let sides = recorded.iter().filter(|entry| entry["side"] == true).map(keys).collect();
    (sessions, sides)
}

/// A stand-in for `fake` that writes down the names in its environment, and whether it was started for a side call
/// (`side_flag` among its arguments), then is the fake.
fn recorder(fixture: &Fixture, fake: &str, side_flag: &str) -> String {
    let recorder = fixture.dir.path().join("record-environment.mjs");
    let script = r#"import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
const side = process.argv.includes(SIDE)
const keys = Object.keys(process.env).filter(key => !key.startsWith('=')).map(key => key.toLowerCase()).sort()
appendFileSync(join(root, 'environments.jsonl'), JSON.stringify({ side, keys }) + '\n')
await import(pathToFileURL(FAKE).href)
"#;
    let script = script.replace("SIDE", &serde_json::to_string(side_flag).unwrap()).replace("FAKE", &serde_json::to_string(fake).unwrap());
    fs::write(&recorder, script).unwrap();
    recorder.to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------------------------------------------------
// Codex.

/// A connected Codex adapter on `config`, with thread `t`, a personal thread and a council judge's on `fixture-model` in
/// the fixture's repository, and the fake's side call answering `script`.
fn codex_on(fixture: &Fixture, runtime: &tokio::runtime::Runtime, script: serde_json::Value, config: CodexAdapterConfig) -> Arc<CodexAdapter> {
    let data = fixture.data();
    fs::create_dir_all(&data).unwrap();
    let record = |extra: serde_json::Value| {
        let mut record = json!({ "codexThreadId": uuid::Uuid::new_v4().to_string(), "cwd": fixture.repo, "modelId": "fixture-model" });
        record.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        record
    };
    fs::write(data.join("codex-threads.json"), json!({
        "t": record(json!({})),
        "personal": record(json!({ "kind": "personal" })),
        "judge": record(json!({ "councilJudge": true })),
    }).to_string()).unwrap();
    fs::write(data.join("oneshot.json"), script.to_string()).unwrap();
    let adapter = Arc::new(CodexAdapter::new(config));
    let (events, _) = tokio::sync::mpsc::unbounded_channel();
    runtime.block_on(adapter.connect(events)).unwrap();
    assert_eq!(adapter.status().connection, "connected");
    adapter
}

fn codex(fixture: &Fixture, runtime: &tokio::runtime::Runtime, script: serde_json::Value, deadline: Duration) -> Arc<CodexAdapter> {
    let mut config = CodexAdapterConfig::fake(fixture.data(), FAKE_CODEX.into());
    config.side_writing_deadline = deadline;
    codex_on(fixture, runtime, script, config)
}

#[test]
fn codex_drafts_the_commit_in_one_ephemeral_exec_with_everything_switched_off() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let adapter = codex(&fixture, &runtime, json!({ "text": "Fix the parser.\n\nBecause it broke." }), Duration::from_secs(60));
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), "Fix the parser\nBecause it broke.");
    let asked = oneshots(&fixture);
    assert_eq!(asked.len(), 1);
    let args: Vec<&str> = asked[0]["args"].as_array().unwrap().iter().map(|arg| arg.as_str().unwrap()).collect();
    let folder = folder(&fixture);
    // The least effort `fixture-model` reports, then every isolation setting and nothing to approve, then stdin.
    assert_eq!(args[..12], ["--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--color", "never", "--cd", folder.as_str(), "--model", "fixture-model", "-c"]);
    assert_eq!(args[12], "model_reasoning_effort=\"low\"");
    assert_eq!(args.last(), Some(&"-"));
    for setting in ["features.shell_tool=false", "features.computer_use=false", "mcp_servers={}", "instructions=\"\"", "notify=[]", "history.persistence=\"none\"", "approval_policy=\"never\""] {
        assert!(args.contains(&setting), "{setting} missing from {args:?}");
    }
    assert_asked_with_the_draft(asked[0]["input"].as_str().unwrap());
    assert_eq!(asked[0]["cwd"].as_str().unwrap().to_lowercase(), folder.to_lowercase());
    assert!(!fixture.data().join("violations.jsonl").exists(), "side writing was not ephemeral, read-only, tool-free and on stdin");
}

/// Node puts every model's reported levels in Sotto's order as it reads Codex's catalog, so a model that reports its
/// highest first still drafts at its least. Rust's catalog once kept Codex's own order.
#[test]
fn codex_drafts_at_the_least_effort_whatever_order_the_model_reports_them_in() {
    let fixture = Fixture::new();
    let runtime = runtime();
    fs::create_dir_all(fixture.data()).unwrap();
    fs::write(fixture.data().join("script.json"), json!({ "models": [{ "id": "model", "model": "fixture-model", "displayName": "Fixture Codex", "isDefault": true,
        "defaultReasoningEffort": "high", "supportedReasoningEfforts": [{ "reasoningEffort": "xhigh" }, { "reasoningEffort": "high" }, { "reasoningEffort": "low" }] }] }).to_string()).unwrap();
    let adapter = codex(&fixture, &runtime, json!({ "text": "Fix the parser" }), Duration::from_secs(60));
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), "Fix the parser");
    let asked = oneshots(&fixture);
    let args: Vec<&str> = asked[0]["args"].as_array().unwrap().iter().map(|arg| arg.as_str().unwrap()).collect();
    assert_eq!(args[12], "model_reasoning_effort=\"low\"", "{args:?}");
}

#[test]
fn codex_that_fails_tries_a_tool_or_outlasts_the_deadline_leaves_nodes_stand_in_subject() {
    let runtime = runtime();
    for script in [json!({ "fail": true }), json!({ "tool": true, "text": "Not kept" })] {
        let fixture = Fixture::new();
        let adapter = codex(&fixture, &runtime, script.clone(), Duration::from_secs(60));
        commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
        assert_eq!(fixture.last_commit(), STAND_IN_SUBJECT, "{script}");
        assert_eq!(oneshots(&fixture).len(), 1);
    }

    let fixture = Fixture::new();
    let adapter = codex(&fixture, &runtime, json!({ "delayMs": 30_000, "text": "Too late" }), Duration::from_millis(1_500));
    // Had the deadline not stopped it, the fake's late answer would be the commit.
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), STAND_IN_SUBJECT);
}

/// Node starts a thread's app-server and its side call on one environment, `nativeEnvironment` with `CODEX_HOME`. Rust's
/// session once kept the host's whole environment, so an API key or a provider endpoint override reached the thread.
#[test]
fn the_thread_and_its_draft_start_codex_on_the_same_environment_nodes() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let mut config = CodexAdapterConfig::fake(fixture.data(), FAKE_CODEX.into());
    config.prefix_args[0] = recorder(&fixture, FAKE_CODEX, "exec");
    let adapter = codex_on(&fixture, &runtime, json!({ "text": "Fix the parser" }), config);
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), "Fix the parser");

    let (sessions, sides) = environments(&fixture);
    assert!(!sessions.is_empty() && sides.len() == 1, "{sessions:?} {sides:?}");
    for session in &sessions {
        assert_eq!(session, &sides[0], "the session and the side call started on different environments");
    }
    assert!(sides[0].contains(&"codex_home".to_string()) && sides[0].contains(&"path".to_string()), "{:?}", sides[0]);
    for key in &sides[0] {
        assert!(crate::providers::codex::NATIVE_ENVIRONMENT_KEYS.contains(&key.as_str()), "{key} is not on Node's list");
    }
}

#[test]
fn codex_writes_nothing_for_a_personal_thread_a_council_judge_a_thread_it_has_no_record_of_or_while_not_connected() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let adapter = codex(&fixture, &runtime, json!({ "text": "Unused" }), Duration::from_secs(60));
    let prompt = commit_message_request(&material(), &WritingSettings::default()).prompt;
    for thread in ["other", "personal", "judge"] {
        assert_eq!(runtime.block_on(adapter.write_short_text(thread.into(), prompt.clone())), Ok(None), "{thread}");
    }
    runtime.block_on(adapter.disconnect()).unwrap();
    assert_eq!(runtime.block_on(adapter.write_short_text("t".into(), prompt)), Ok(None));
    assert!(oneshots(&fixture).is_empty());
}

// ---------------------------------------------------------------------------------------------------------------------
// Grok Build.

/// A connected Grok adapter on `config`, with thread `t` and a personal thread on `fixture-model` in the fixture's
/// repository, and the fake's side call answering `script`.
fn grok_on(fixture: &Fixture, runtime: &tokio::runtime::Runtime, script: serde_json::Value, config: AcpAdapterConfig) -> Arc<AcpAdapter> {
    let data = fixture.data();
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join("grok-threads.json"), json!({
        "t": { "grokSessionId": "3d6f4ac1-4b9e-43f3-aa5e-2238e5f6c649", "cwd": fixture.repo, "modelId": "fixture-model" },
        "personal": { "grokSessionId": "4e7a5bd2-5caf-4404-bb6f-3349f6a7d75a", "cwd": fixture.repo, "modelId": "fixture-model", "kind": "personal" },
    }).to_string()).unwrap();
    fs::write(data.join("oneshot.json"), script.to_string()).unwrap();
    let adapter = Arc::new(AcpAdapter::new(config));
    let (events, _) = tokio::sync::mpsc::unbounded_channel();
    runtime.block_on(adapter.connect(events)).unwrap();
    assert_eq!(adapter.status().connection, "connected");
    adapter
}

fn grok(fixture: &Fixture, runtime: &tokio::runtime::Runtime, script: serde_json::Value, deadline: Duration) -> Arc<AcpAdapter> {
    let mut config = AcpAdapterConfig::fake(AcpFlavor::Grok, fixture.data(), FAKE_GROK.into());
    config.side_writing_deadline = deadline;
    grok_on(fixture, runtime, script, config)
}

/// The throwaway homes left in the Grok side calls' folder.
fn homes_left(fixture: &Fixture) -> Vec<String> {
    fs::read_dir(fixture.data().join("writing").join("grok")).map(|entries| entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default()
}

#[test]
fn grok_drafts_the_commit_in_a_tool_free_session_on_a_throwaway_home() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let adapter = grok(&fixture, &runtime, json!({ "text": "Fix the parser.\n\nBecause it broke." }), Duration::from_secs(60));
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), "Fix the parser\nBecause it broke.");

    let frames = oneshots(&fixture);
    let methods: Vec<&str> = frames.iter().map(|call| call["frame"]["method"].as_str().unwrap()).collect();
    assert_eq!(methods, ["initialize", "authenticate", "session/new", "session/set_model", "session/prompt"]);
    let folder = folder(&fixture);
    let args: Vec<&str> = frames[0]["args"].as_array().unwrap().iter().map(|arg| arg.as_str().unwrap()).collect();
    assert_eq!(args, ["--cwd", folder.as_str(), "--tools", "", "--no-subagents", "--disable-web-search", "--permission-mode", "dontAsk", "--deny", "*", "agent", "--no-leader", "stdio"]);
    assert_eq!(frames[0]["cwd"].as_str().unwrap().to_lowercase(), folder.to_lowercase());
    assert_eq!(frames[1]["frame"]["params"], json!({ "methodId": "cached_token", "_meta": { "headless": true } }));
    let created = &frames[2]["frame"]["params"];
    assert_eq!(created["cwd"], json!(folder));
    assert_eq!(created["_meta"]["systemPromptOverride"], json!(format!("{INSTRUCTION}\nTools and all computer actions are unavailable in this writing session.")));
    assert_eq!(created["_meta"]["agentProfile"]["name"], "sotto-writing");
    // The fake reports `high` then `low`; Sotto's order puts `low` first, and that is what a side call runs at.
    assert_eq!(frames[3]["frame"]["params"], json!({ "sessionId": "side-writing-session", "modelId": "fixture-model", "_meta": { "reasoningEffort": "low" } }));
    assert_asked_with_the_draft(frames[4]["frame"]["params"]["prompt"][0]["text"].as_str().unwrap());

    // Its home was its own, in the host's writing folder, and is gone.
    let home = std::path::PathBuf::from(frames[0]["home"].as_str().unwrap());
    let session = home.parent().unwrap();
    assert_eq!(home.file_name().unwrap(), "home");
    assert!(session.file_name().unwrap().to_string_lossy().starts_with("grok-"), "{home:?}");
    assert_eq!(session.parent().unwrap(), fixture.data().join("writing").join("grok"));
    assert!(homes_left(&fixture).is_empty(), "{:?}", homes_left(&fixture));
    assert!(!fixture.data().join("violations.jsonl").exists(), "side writing opened a session with tools");
}

#[test]
fn grok_that_fails_or_outlasts_the_deadline_leaves_nodes_stand_in_subject_and_no_home() {
    let runtime = runtime();
    let fixture = Fixture::new();
    let adapter = grok(&fixture, &runtime, json!({ "fail": true }), Duration::from_secs(60));
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), STAND_IN_SUBJECT);
    assert!(oneshots(&fixture).iter().any(|call| call["frame"]["method"] == "session/prompt"));
    assert!(homes_left(&fixture).is_empty());

    let fixture = Fixture::new();
    let adapter = grok(&fixture, &runtime, json!({ "delayMs": 30_000, "text": "Too late" }), Duration::from_millis(1_500));
    // Had the deadline not stopped it, the fake's late answer would be the commit.
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), STAND_IN_SUBJECT);
    assert!(homes_left(&fixture).is_empty());
}

/// Node starts a Grok thread's process on `grokEnvironment`, and its side call on the narrower list `withSession` keeps
/// with the side call's own home and every feature off. Rust's session once kept the host's whole environment.
#[test]
fn the_thread_and_its_draft_start_grok_on_the_environments_node_gives_each() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let mut config = AcpAdapterConfig::fake(AcpFlavor::Grok, fixture.data(), FAKE_GROK.into());
    config.prefix_args[0] = recorder(&fixture, FAKE_GROK, "--deny");
    let adapter = grok_on(&fixture, &runtime, json!({ "text": "Fix the parser" }), config);
    commit(&fixture, &drafting(&fixture, &runtime, adapter, false), None);
    assert_eq!(fixture.last_commit(), "Fix the parser");

    let (sessions, sides) = environments(&fixture);
    assert!(!sessions.is_empty() && sides.len() == 1, "{sessions:?} {sides:?}");
    let session_flags = ["grok_disable_api_key_auth", "grok_disable_autoupdater", "grok_default_selected_permission", "grok_remember_tool_approvals"];
    for session in &sessions {
        assert!(session.contains(&"path".to_string()) && session_flags.iter().all(|flag| session.contains(&flag.to_string())), "{session:?}");
        for key in session {
            let listed = crate::providers::grok_side::SESSION_ENVIRONMENT_KEYS.contains(&key.as_str()) || session_flags.contains(&key.as_str()) || key == "grok_home" || key == "grok_auth_path";
            assert!(listed, "{key} is not in Node's grokEnvironment");
        }
    }
    let side = &sides[0];
    let side_flags = [
        "grok_home", "grok_auth_path", "grok_disable_api_key_auth", "grok_disable_autoupdater", "grok_memory", "grok_subagents", "grok_write_file", "grok_web_fetch",
        "grok_tool_search", "grok_lsp_tools", "grok_managed_mcps_enabled", "grok_managed_mcp_gateway_tools_enabled", "grok_default_selected_permission",
        "grok_remember_tool_approvals", "grok_telemetry_enabled", "grok_telemetry_trace_upload", "grok_cursor_skills_enabled", "grok_cursor_rules_enabled",
        "grok_cursor_agents_enabled", "grok_cursor_mcps_enabled", "grok_cursor_hooks_enabled", "grok_claude_skills_enabled", "grok_claude_rules_enabled",
        "grok_claude_agents_enabled", "grok_claude_mcps_enabled", "grok_claude_hooks_enabled",
    ];
    assert!(side.contains(&"path".to_string()) && side_flags.iter().all(|flag| side.contains(&flag.to_string())), "{side:?}");
    for key in side {
        assert!(crate::providers::grok_side::SIDE_ENVIRONMENT_KEYS.contains(&key.as_str()) || side_flags.contains(&key.as_str()), "{key} is not in Node's side-call environment");
    }
}

#[test]
fn grok_writes_nothing_for_a_personal_thread_a_thread_it_has_no_record_of_or_while_not_connected_nor_does_devin() {
    let fixture = Fixture::new();
    let runtime = runtime();
    let adapter = grok(&fixture, &runtime, json!({ "text": "Unused" }), Duration::from_secs(60));
    let prompt = commit_message_request(&material(), &WritingSettings::default()).prompt;
    for thread in ["other", "personal"] {
        assert_eq!(runtime.block_on(adapter.write_short_text(thread.into(), prompt.clone())), Ok(None), "{thread}");
    }
    runtime.block_on(adapter.disconnect()).unwrap();
    assert_eq!(runtime.block_on(adapter.write_short_text("t".into(), prompt.clone())), Ok(None));
    assert!(oneshots(&fixture).is_empty());

    // Node's Devin adapter has no side call, and the adapter Rust shares with it writes nothing for it.
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.data()).unwrap();
    fs::write(fixture.data().join("devin-threads.json"), json!({ "t": { "devinSessionId": "s", "cwd": fixture.repo, "modelId": "fixture-model" } }).to_string()).unwrap();
    let devin = Arc::new(AcpAdapter::new(AcpAdapterConfig::fake(AcpFlavor::Devin, fixture.data(), FAKE_DEVIN.into())));
    let (events, _) = tokio::sync::mpsc::unbounded_channel();
    runtime.block_on(devin.connect(events)).unwrap();
    assert_eq!(runtime.block_on(devin.write_short_text("t".into(), prompt)), Ok(None));
}
