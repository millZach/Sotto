//! The commit draft on Codex, as the fake the Node tests use answers its side call
//! (`tests/fixtures/fakeCodexAppServer.mjs`), so nothing reaches a provider or the network.

use super::*;
use crate::providers::{CodexAdapter, CodexAdapterConfig};

const FAKE_CODEX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/fakeCodexAppServer.mjs");

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
