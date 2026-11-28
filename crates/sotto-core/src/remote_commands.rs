use serde_json::{Map, Value};

use crate::protocol::HostErrorCode;

/// Exact closed remote command allow-list (ADR-0004), matching `REMOTE_COMMANDS` in
/// `src/host/remoteCommands.ts`. Any unknown command type, retired management/voice command, or
/// unlisted field is refused with `invalid_request`.
pub fn allowed_command_fields(command_type: &str) -> Option<&'static [&'static str]> {
    let fields: &'static [&'static str] = match command_type {
        "configure" => &["patch"],
        "compose" => &["text", "attachments", "threadId", "draftId"],
        "send" => &["draft"],
        "cancel-draft" => &[],
        "connect" => &["provider", "notice"],
        "disconnect" => &["provider"],
        "refresh" => &["provider"],
        "refresh-thread-skills" => &["threadId", "forceReload"],
        "check-client-updates" => &[],
        "dismiss-client-updates" => &[],
        "queue-client-updates" => &["providers"],
        "cancel-client-updates" => &["providers"],
        "save-thread-draft" => &[
            "threadId",
            "draftId",
            "text",
            "attachments",
            "skills",
            "files",
            "requestId",
            "questionsDigest",
            "expectedDraftId",
            "composer",
        ],
        "recover-draft" => &["threadId"],
        "manual-send" => &["threadId", "text", "attachments", "skills", "files", "draftId"],
        "queue-followup" => &["threadId", "draftId", "text", "attachments", "skills", "files"],
        "edit-followup" => &["threadId", "itemId", "text", "attachments", "skills", "files"],
        "steer-followup" => &["threadId", "itemId"],
        "remove-followup" => &["threadId", "itemId"],
        "reorder-followups" => &["threadId", "itemIds"],
        "resume-followups" => &["threadId"],
        "steer" => &["threadId", "draftId", "text", "attachments", "skills", "files"],
        "create-project" => &["provider", "title", "path", "useExisting", "gitInit"],
        "select-project" | "settle-project" | "restore-project" => &["projectId"],
        "settle-thread" | "restore-thread" | "regenerate-thread-title" | "retry-thread-worktree"
        | "preview-reclaim-thread-worktree" | "preview-delete-thread" | "git-pull"
        | "git-init" | "cancel-restart" | "select-thread" | "start-thread-session"
        | "interrupt" | "compact-thread" => &["threadId"],
        "rename-thread" => &["threadId", "title"],
        "create-owlet" => &[
            "threadId",
            "name",
            "role",
            "modelId",
            "reasoningEffort",
            "runtimeMode",
            "providerMode",
        ],
        "set-owlet" => &["threadId", "name", "role"],
        "create-thread" => &[
            "projectId",
            "title",
            "modelId",
            "titleSource",
            "threadId",
            "workingCopy",
            "baseBranch",
            "startFromOrigin",
            "existingWorktreePath",
            "reasoningEffort",
            "runtimeMode",
            "providerMode",
            "speed",
            "fastMode",
            "managed",
        ],
        "continue-agent" => &[
            "threadId",
            "agentId",
            "newThreadId",
            "modelId",
            "handover",
            "workingCopy",
            "baseBranch",
            "startFromOrigin",
        ],
        "fork-thread" => &[
            "threadId",
            "messageId",
            "newThreadId",
            "modelId",
            "workingCopy",
            "baseBranch",
            "startFromOrigin",
        ],
        "refresh-thread-worktree" => &["threadId", "background"],
        "restore-thread-branch" => &["threadId", "withUncommittedChanges"],
        "delete-thread" => &[
            "threadId",
            "confirmedIgnored",
            "confirmedItems",
            "confirmedRepositories",
        ],
        "reclaim-thread-worktree" => &[
            "threadId",
            "afterSettle",
            "withUncommittedChanges",
            "confirmedIgnored",
            "confirmedItems",
            "confirmedRepositories",
        ],
        "configure-thread-working-copy" => &[
            "threadId",
            "workingCopy",
            "baseBranch",
            "startFromOrigin",
            "existingWorktreePath",
        ],
        "git-action" => &[
            "threadId",
            "actionId",
            "action",
            "commitMessage",
            "featureBranch",
            "filePaths",
            "allowDefaultBranch",
        ],
        "git-switch-branch" => &["threadId", "ref", "create"],
        "bring-changes-back" => &["threadId", "actionId", "mergeCommit", "away"],
        "git-publish" => &["threadId", "repository", "visibility"],
        "git-pull-request-action" => &["threadId", "url", "action", "method", "confirmation"],
        "git-link-pull-request" => &["threadId", "reference"],
        "git-unlink-pull-request" => &["threadId", "url"],
        "git-checkout-pull-request" => &["threadId", "reference", "mode"],
        "babysit-pull-request" | "stop-babysitting" => &["threadId", "url"],
        "snooze-thread" => &["threadId", "until"],
        "configure-thread" => &[
            "threadId",
            "modelId",
            "reasoningEffort",
            "runtimeMode",
            "providerMode",
            "fastMode",
            "speed",
        ],
        "observe-threads" => &["threadIds"],
        "load-earlier-messages" => &["threadId", "throughMessageId"],
        "dismiss-failures" => &["failures"],
        "stop-detached-run" => &["threadId", "runId"],
        "answer" => &[
            "threadId",
            "requestId",
            "answer",
            "approved",
            "questionAnswers",
            "permissionChoice",
            "skipped",
            "attachments",
        ],
        _ => return None,
    };
    Some(fields)
}

pub const REMOTE_CONFIGURATION_FIELDS: &[&str] = &[
    "provider",
    "enabledProviders",
    "enabled",
    "defaultModelId",
    "reasoning",
    "reasoningModel",
    "reasoningEffort",
    "projectsDirectory",
    "newThreadModelId",
    "newThreadReasoningEffort",
    "newThreadSpeed",
    "newThreadRuntimeMode",
    "museDisableSandbox",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRefusal {
    pub code: HostErrorCode,
    pub message: Option<String>,
}

/// Validates a remote command object against the closed allow-list and ADR-0004 answer policy.
pub fn validate_remote_command(
    command: &Map<String, Value>,
    may_answer: bool,
) -> Result<&str, CommandRefusal> {
    let Some(cmd_type) = command.get("type").and_then(Value::as_str) else {
        return Err(CommandRefusal {
            code: HostErrorCode::InvalidRequest,
            message: None,
        });
    };

    let Some(allowed) = allowed_command_fields(cmd_type) else {
        return Err(CommandRefusal {
            code: HostErrorCode::InvalidRequest,
            message: None,
        });
    };

    for key in command.keys() {
        if key != "type" && !allowed.contains(&key.as_str()) {
            return Err(CommandRefusal {
                code: HostErrorCode::InvalidRequest,
                message: None,
            });
        }
    }

    // ADR-0068: managed creation is retired; `managed: true` is refused, `false` or omission allowed.
    if cmd_type == "create-thread" {
        if let Some(managed) = command.get("managed") {
            if managed != &Value::Bool(false) {
                return Err(CommandRefusal {
                    code: HostErrorCode::InvalidRequest,
                    message: None,
                });
            }
        }
    }

    // `connect` may only carry `notice: false` remotely (ADR-0068 October 9 exception).
    if cmd_type == "connect" {
        if let Some(notice) = command.get("notice") {
            if notice != &Value::Bool(false) {
                return Err(CommandRefusal {
                    code: HostErrorCode::InvalidRequest,
                    message: None,
                });
            }
        }
    }

    // `configure` patch is closed to REMOTE_CONFIGURATION_FIELDS, and never turns muse sandbox off.
    if cmd_type == "configure" {
        let Some(patch) = command.get("patch").and_then(Value::as_object) else {
            return Err(CommandRefusal {
                code: HostErrorCode::InvalidRequest,
                message: None,
            });
        };
        for key in patch.keys() {
            if !REMOTE_CONFIGURATION_FIELDS.contains(&key.as_str()) {
                return Err(CommandRefusal {
                    code: HostErrorCode::InvalidRequest,
                    message: None,
                });
            }
        }
        if patch.get("museDisableSandbox") == Some(&Value::Bool(true)) {
            return Err(CommandRefusal {
                code: HostErrorCode::Forbidden,
                message: None,
            });
        }
    }

    if remote_command_needs_answer_policy(cmd_type, command) && !may_answer {
        return Err(CommandRefusal {
            code: HostErrorCode::Forbidden,
            message: None,
        });
    }

    Ok(cmd_type)
}

fn is_valid_id(val: Option<&Value>) -> bool {
    val.and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 512)
}

fn is_valid_uuid(val: Option<&Value>) -> bool {
    val.and_then(Value::as_str)
        .is_some_and(|s| s.len() == 36 && uuid::Uuid::parse_str(s).is_ok())
}

fn is_valid_hex64(val: Option<&Value>) -> bool {
    val.and_then(Value::as_str)
        .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
}

fn is_valid_prompt_text(val: Option<&Value>) -> bool {
    val.and_then(Value::as_str)
        .is_some_and(|s| s.encode_utf16().count() <= 100_000)
}

fn is_valid_attachments_opt(val: Option<&Value>) -> bool {
    let Some(v) = val else {
        return true;
    };
    let Some(arr) = v.as_array() else {
        return false;
    };
    if arr.len() > crate::attachment_store::AGENT_MAX_ATTACHMENTS {
        return false;
    }
    let mut seen_ids = std::collections::HashSet::new();
    for item in arr {
        let Some(obj) = item.as_object() else {
            return false;
        };
        let Some(id) = obj.get("id").and_then(Value::as_str) else {
            return false;
        };
        if id.is_empty() || id.encode_utf16().count() > 512 || !seen_ids.insert(id) {
            return false;
        }
        let Some(name) = obj.get("name").and_then(Value::as_str) else {
            return false;
        };
        if name.is_empty() || name.encode_utf16().count() > 512 {
            return false;
        }
        let Some(mime) = obj.get("mimeType").and_then(Value::as_str) else {
            return false;
        };
        if mime.is_empty() || mime.encode_utf16().count() > 256 {
            return false;
        }
        let Some(size) = obj.get("sizeBytes").and_then(Value::as_u64) else {
            return false;
        };
        if size == 0 {
            return false;
        }
        if obj.contains_key("digest") && !is_valid_hex64(obj.get("digest")) {
            return false;
        }
    }
    true
}

/// Strict shape validation for `compose` (`src/shared/agents.ts:1619`).
pub fn valid_compose_shape(command: &Map<String, Value>) -> bool {
    if command.get("type").and_then(Value::as_str) != Some("compose") {
        return false;
    }
    if !command
        .keys()
        .all(|k| matches!(k.as_str(), "type" | "threadId" | "draftId" | "text" | "attachments"))
    {
        return false;
    }
    if !is_valid_prompt_text(command.get("text")) {
        return false;
    }
    if command.contains_key("threadId") && !is_valid_id(command.get("threadId")) {
        return false;
    }
    if command.contains_key("draftId") && !is_valid_uuid(command.get("draftId")) {
        return false;
    }
    is_valid_attachments_opt(command.get("attachments"))
}

/// Strict shape validation for `send` (`src/shared/agents.ts:1625-1629`).
pub fn valid_send_shape(command: &Map<String, Value>) -> bool {
    if command.get("type").and_then(Value::as_str) != Some("send") {
        return false;
    }
    if !command.keys().all(|k| matches!(k.as_str(), "type" | "draft")) {
        return false;
    }
    let Some(draft_val) = command.get("draft") else {
        return true;
    };
    let Some(draft) = draft_val.as_object() else {
        return false;
    };
    if !draft
        .keys()
        .all(|k| matches!(k.as_str(), "threadId" | "draftId" | "text" | "attachments" | "binding"))
    {
        return false;
    }
    if !is_valid_id(draft.get("threadId")) || !is_valid_prompt_text(draft.get("text")) {
        return false;
    }
    if draft.contains_key("draftId") && !is_valid_uuid(draft.get("draftId")) {
        return false;
    }
    if !is_valid_attachments_opt(draft.get("attachments")) {
        return false;
    }
    if let Some(binding_val) = draft.get("binding") {
        let Some(binding) = binding_val.as_object() else {
            return false;
        };
        if binding.len() != 2 || !binding.contains_key("requestId") || !binding.contains_key("questionsDigest") {
            return false;
        }
        let req_null = binding.get("requestId") == Some(&Value::Null);
        let dig_null = binding.get("questionsDigest") == Some(&Value::Null);
        if req_null != dig_null {
            return false;
        }
        if !req_null && (!is_valid_id(binding.get("requestId")) || !is_valid_hex64(binding.get("questionsDigest"))) {
            return false;
        }
    }
    true
}

/// Strict shape validation for `cancel-draft` (`src/shared/agents.ts:1639`).
pub fn valid_cancel_draft_shape(command: &Map<String, Value>) -> bool {
    command.len() == 1 && command.get("type").and_then(Value::as_str) == Some("cancel-draft")
}

/// Strict shape validation for `refresh-thread-skills` (`src/shared/agents.ts:1606`).
pub fn valid_refresh_skills_shape(command: &Map<String, Value>) -> bool {
    if command.get("type").and_then(Value::as_str) != Some("refresh-thread-skills") {
        return false;
    }
    if !command.keys().all(|k| matches!(k.as_str(), "type" | "threadId" | "forceReload")) {
        return false;
    }
    if !is_valid_id(command.get("threadId")) {
        return false;
    }
    command.get("forceReload").is_none_or(Value::is_boolean)
}

/// Strict shape validation for `stop-detached-run` (`src/shared/agents.ts:1809`).
pub fn valid_stop_detached_run_shape(command: &Map<String, Value>) -> bool {
    command.get("type").and_then(Value::as_str) == Some("stop-detached-run")
        && command.len() == 3
        && is_valid_id(command.get("threadId"))
        && is_valid_uuid(command.get("runId"))
}

/// Strict shape validation for `babysit-pull-request` and `stop-babysitting` (`src/shared/agents.ts:1779-1780`).
pub fn valid_babysit_shape(command: &Map<String, Value>) -> bool {
    matches!(
        command.get("type").and_then(Value::as_str),
        Some("babysit-pull-request" | "stop-babysitting")
    ) && command.len() == 3
        && is_valid_id(command.get("threadId"))
        && command
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(crate::pull_requests::is_valid_pull_request_url)
}

/// Strict shape validation for `{ type, threadId }` commands (`start-thread-session`, `regenerate-thread-title`, `cancel-restart`).
pub fn valid_thread_id_only_shape(command: &Map<String, Value>, expected_type: &str) -> bool {
    command.len() == 2
        && command.get("type").and_then(Value::as_str) == Some(expected_type)
        && is_valid_id(command.get("threadId"))
}

fn remote_command_needs_answer_policy(cmd_type: &str, command: &Map<String, Value>) -> bool {
    match cmd_type {
        "answer" | "delete-thread" => true,
        "save-thread-draft" => command.get("requestId").is_some_and(|v| !v.is_null()),
        "create-thread" | "configure-thread" | "create-owlet" => {
            command
                .get("runtimeMode")
                .and_then(Value::as_str)
                .is_some_and(|mode| mode != "approval-required")
                || command.get("providerMode").is_some_and(|v| !v.is_null())
        }
        "configure" => command
            .get("patch")
            .and_then(Value::as_object)
            .and_then(|p| p.get("newThreadRuntimeMode"))
            .and_then(Value::as_str)
            .is_some_and(|mode| mode != "approval-required"),
        "restore-thread-branch" => command.get("withUncommittedChanges") == Some(&Value::Bool(true)),
        // Each confirmation is the user's that work goes with the folder (ADR-0041), so any one of them, given at all,
        // takes the policy, as Node reads `Boolean(command.confirmedIgnored?.length)` and the rest.
        "reclaim-thread-worktree" => {
            let given = |key: &str| command.get(key).and_then(Value::as_array).is_some_and(|list| !list.is_empty());
            command.get("withUncommittedChanges") == Some(&Value::Bool(true))
                || given("confirmedIgnored")
                || given("confirmedItems")
                || given("confirmedRepositories")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_unknown_command_and_extra_fields() {
        let bad_op = json!({ "type": "assign", "threadId": "t1" });
        assert_eq!(
            validate_remote_command(bad_op.as_object().unwrap(), true)
                .unwrap_err()
                .code,
            HostErrorCode::InvalidRequest
        );

        let extra_field = json!({ "type": "interrupt", "threadId": "t1", "refereeField": true });
        assert_eq!(
            validate_remote_command(extra_field.as_object().unwrap(), true)
                .unwrap_err()
                .code,
            HostErrorCode::InvalidRequest
        );
    }

    /// Remove worktree takes the remote-answer policy for each confirmation that work goes with the folder, and only when
    /// it is given, as Node's `remoteCommandNeedsAnswerPolicy` reads an empty list as none.
    #[test]
    fn takes_the_answer_policy_for_a_removals_confirmations() {
        let needs = |command: Value| validate_remote_command(command.as_object().unwrap(), false).is_err();
        assert!(!needs(json!({ "type": "reclaim-thread-worktree", "threadId": "t" })));
        assert!(!needs(json!({ "type": "reclaim-thread-worktree", "threadId": "t", "withUncommittedChanges": false, "confirmedIgnored": [], "confirmedItems": [], "confirmedRepositories": [] })));
        assert!(!needs(json!({ "type": "preview-reclaim-thread-worktree", "threadId": "t" })));
        for given in [
            json!({ "type": "reclaim-thread-worktree", "threadId": "t", "withUncommittedChanges": true }),
            json!({ "type": "reclaim-thread-worktree", "threadId": "t", "confirmedIgnored": ["build/"] }),
            json!({ "type": "reclaim-thread-worktree", "threadId": "t", "confirmedItems": [{ "path": "build/", "fileCount": 1 }] }),
            json!({ "type": "reclaim-thread-worktree", "threadId": "t", "confirmedRepositories": [{ "path": "r/", "changeCount": 0, "kind": "repository" }] }),
        ] {
            assert!(needs(given.clone()), "{given}");
        }
    }

    #[test]
    fn enforces_answer_policy_on_grants() {
        let answer = json!({ "type": "answer", "threadId": "t1", "requestId": "r1", "answer": "yes" });
        assert_eq!(
            validate_remote_command(answer.as_object().unwrap(), false)
                .unwrap_err()
                .code,
            HostErrorCode::Forbidden
        );
        assert_eq!(
            validate_remote_command(answer.as_object().unwrap(), true).unwrap(),
            "answer"
        );
    }

    #[test]
    fn accepts_managed_false_and_refuses_managed_true() {
        let ok = json!({ "type": "create-thread", "projectId": "p1", "managed": false });
        assert_eq!(
            validate_remote_command(ok.as_object().unwrap(), false).unwrap(),
            "create-thread"
        );
        let bad = json!({ "type": "create-thread", "projectId": "p1", "managed": true });
        assert_eq!(
            validate_remote_command(bad.as_object().unwrap(), true)
                .unwrap_err()
                .code,
            HostErrorCode::InvalidRequest
        );
    }

    #[test]
    fn validates_slice_23_command_shapes_strictly() {
        let obj = |v: Value| v.as_object().unwrap().clone();
        let uid = "00000000-0000-4000-8000-000000000001";
        let hex64 = "a".repeat(64);
        assert!(valid_compose_shape(&obj(json!({ "type": "compose", "text": "hi" }))));
        assert!(valid_compose_shape(&obj(json!({ "type": "compose", "threadId": "t1", "draftId": uid, "text": "hi", "attachments": [] }))));
        assert!(!valid_compose_shape(&obj(json!({ "type": "compose", "text": "hi", "draftId": "not-a-uuid" }))));
        assert!(!valid_compose_shape(&obj(json!({ "type": "compose", "text": "hi", "extra": 1 }))));

        assert!(valid_send_shape(&obj(json!({ "type": "send" }))));
        assert!(valid_send_shape(&obj(json!({
            "type": "send",
            "draft": {
                "threadId": "t1",
                "draftId": uid,
                "text": "go",
                "binding": { "requestId": "req-1", "questionsDigest": hex64 }
            }
        }))));
        assert!(valid_send_shape(&obj(json!({
            "type": "send",
            "draft": {
                "threadId": "t1",
                "text": "go",
                "binding": { "requestId": null, "questionsDigest": null }
            }
        }))));
        // Mismatched nullability in binding is invalid.
        assert!(!valid_send_shape(&obj(json!({
            "type": "send",
            "draft": {
                "threadId": "t1",
                "text": "go",
                "binding": { "requestId": "req-1", "questionsDigest": null }
            }
        }))));

        assert!(valid_cancel_draft_shape(&obj(json!({ "type": "cancel-draft" }))));
        assert!(!valid_cancel_draft_shape(&obj(json!({ "type": "cancel-draft", "threadId": "t1" }))));

        assert!(valid_refresh_skills_shape(&obj(json!({ "type": "refresh-thread-skills", "threadId": "t1", "forceReload": true }))));
        assert!(!valid_refresh_skills_shape(&obj(json!({ "type": "refresh-thread-skills", "threadId": "t1", "forceReload": "yes" }))));

        assert!(valid_stop_detached_run_shape(&obj(json!({ "type": "stop-detached-run", "threadId": "t1", "runId": uid }))));
        assert!(!valid_stop_detached_run_shape(&obj(json!({ "type": "stop-detached-run", "threadId": "t1", "runId": "bad" }))));

        assert!(valid_babysit_shape(&obj(json!({ "type": "babysit-pull-request", "threadId": "t1", "url": "https://github.com/o/r/pull/1" }))));
        assert!(!valid_babysit_shape(&obj(json!({ "type": "babysit-pull-request", "threadId": "t1", "url": "https://example.com/1" }))));

        assert!(valid_thread_id_only_shape(&obj(json!({ "type": "cancel-restart", "threadId": "t1" })), "cancel-restart"));
        assert!(!valid_thread_id_only_shape(&obj(json!({ "type": "cancel-restart", "threadId": "" })), "cancel-restart"));
    }
}
