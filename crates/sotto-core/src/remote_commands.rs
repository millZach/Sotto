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
        "reclaim-thread-worktree" => {
            command.get("withUncommittedChanges") == Some(&Value::Bool(true))
                || command.get("confirmedIgnored").is_some_and(|v| !v.is_null())
                || command.get("confirmedItems").is_some_and(|v| !v.is_null())
                || command
                    .get("confirmedRepositories")
                    .is_some_and(|v| !v.is_null())
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
}
