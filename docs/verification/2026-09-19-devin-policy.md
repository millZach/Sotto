# Devin approval profile compatibility

September 19, 2026. Native Windows Devin CLI 3000.10.31 (b98cc431), ACP 1, truthful client identity `sotto`. This is evidence for the constrained approval profile, not a claim that the native Normal mode works or that every Devin configuration is compatible.

## Synthetic checks

Checks used independent disposable Git projects, synthetic text and marker files, and the account-advertised `swe-1-6-fast` model. Probe scripts emitted event names, counts, shapes and boolean assertions. They did not emit prompt/response bodies, native stderr, credentials or native server names/commands. No native user configuration was edited.

The owned profile asks for `edit`, `write`, `Write(**)`, `Write(/**)`, `exec`, `Fetch(*)` and `mcp__*`, with no allows or denies. All seven configuration imports, subagents and automatic updates are disabled.

| Check | Result |
| --- | --- |
| Exact project-local command allow with owned asks | One permission request; rejected. |
| Project-local tool-wide edit/write and workspace write allows with owned asks | One permission request; rejected; marker absent. |
| Project-local tool-wide edit/write and absolute-path write allows, outside cwd | One permission request; rejected. |
| Same command allow without owned asks | Command completed with no permission request. |
| Same workspace write allows without owned asks | Marker created with no permission request. |
| Same outside-cwd write allows without owned asks | Outside marker created with no permission request. |
| New process loads an existing session with owned asks | Edit requested permission; rejected; marker absent. |
| `_cognition.ai/config/read` | Returns normalized owned user profile and its path. Project permissions are absent: this is not effective merged-policy readback. |
| Native MCP location with custom `--config` | Initialize metadata still points to native user `mcp_config.json`; it is not relocated alongside the owned profile. |
| `_cognition.ai/mcp/serversChanged` | Empty params object; it cannot establish which servers exist. |
| `_cognition.ai/mcp/listServers` and `_cognition.ai/plugins/list` | Returned method-not-found with the truthful tested client. |
| `plugins list` | Exact empty-list sentinel, with successful exit and empty stderr. |
| `mcp list`, existing native configuration | One explicitly disabled entry. Names and command fields were not emitted. |
| Synthetic project MCP configuration | Adding a disabled entry yields another disabled item. Enabling it changes the status marker and removes the disabled suffix; the strict parser rejects that output. |

A synthetic Claude hook did not run under either import-disabled or project-import-enabled settings, including SessionStart and UserPromptSubmit attempts. That test did not establish hook suppression. The implementation refuses native project configuration instead of relying on this inconclusive result.

## Implemented compatibility restriction

`devinPolicy.ts` creates a versioned Sotto-owned profile and refuses a modified profile. The native user-profile response must confirm its absolute path, exact permissions/imports, empty hooks/MCP map, and disabled subagents/automatic updates. Native user/project files are never overwritten.

Before starting and before further prompts, the host must use the policy checks to refuse native `.devin` config, local config, hooks and MCP files in the working folder and its ancestors. Unreadable paths fail closed. Those are the only places the pinned CLI reads them from: the [descendant experiment](2026-09-21-devin-config-discovery.md) of September 21 shows the same file ignored one level below the working folder and honoured once that folder is the working folder, so the walk below it, its traversal bounds and its linked-directory refusal were removed. A folder's size no longer decides whether a thread may run. Native user MCP configuration is inspected through the CLI's status output, never by reading potential credentials. Empty or entirely disabled MCP lists are accepted; enabled or unfamiliar output is refused. Plugins require the exact empty-list response. Subprocess checks have a 15-second limit and 64 KiB output bound, and their output never becomes an error cause or log.

The host must pass its owned `--config` path to integration checks, repeat them after create/load and before sending, and stop on newly surfaced incompatible integrations. These checks do not establish the absence of pending cloud-managed plugins, an immutable native runtime policy, or protection against hostile same-user concurrent filesystem mutation. No such guarantee is claimed. Runtime and model/version restrictions belong to the adapter compatibility contract.

## Sources and validation

Installed primary documentation: `reference/permissions.mdx`, `reference/configuration/global-vs-local.mdx`, `reference/configuration/read-config-from.mdx`, `extensibility/hooks/overview.mdx`, `extensibility/mcp/configuration.mdx`, and `extensibility/plugins/overview.mdx`. Installed Desktop SDK source supplied the configuration and MCP/plugin method names. Native CLI help supplied the list commands.

The complete implemented preflight also passed against the actual native installation in a fresh temporary working folder, accepting its disabled MCP entry. Fifteen focused policy tests passed, including subprocess output containment, inherited/nested config refusal, profile tampering, and enabled/unknown MCP rejection. Focused ESLint passed. An earlier whole-workspace typecheck encountered concurrent implementation gaps (missing Devin host registration/module), so it was not reported as a passing application gate.


## Native profile normalization correction

A full host connection exposed one native rewrite: initialization adds `version: 1` to an otherwise unchanged owned profile. The original byte-for-byte comparison therefore rejected the next operation. An independent temporary-profile experiment reproduced this before `session/new`; create/delete/close and model selection made no further semantic changes.

The generated profile now explicitly includes version 1. Later checks parse the profile and require exact semantic equality, including the complete root key set. Whitespace and key order may change; additional fields, other versions, missing rules and changed imports still fail. Native readback separately permits known normalized defaults and rejects unknown fields or changed proxy, organization, shell, sandbox and tool settings. No global native configuration was changed. Seventeen focused policy tests and focused lint passed; native initialize/readback/create/delete/close passed again with the corrected check.


## Adapter boundary audit

A bounded policy audit found that preflight originally ran before native session creation/load without a matching check afterward. The adapter now repeats validation after catalog discovery, new-thread creation and load/replay, and immediately before dispatch after history refresh. Validation failure closes the affected native connection.

Five deterministic boundary regressions passed: changed policy after creation, enabled MCP after creation, enabled MCP on resumed load, enabled MCP during observer replay before a follow-up, and enabled MCP during catalog discovery. The tests assert no new prompt was dispatched, and rejected creation leaves no live native owner. Fixture changes are opt-in synthetic switches; normal fixture traffic is unchanged. Focused fixture/test ESLint passed.

Two no-model native measurements in an empty working folder took 395 and 452 milliseconds for the pair of plugin/MCP list subprocesses, excluding ACP startup. Directory checks took 2 and 3 milliseconds there. This supported reducing repeated idle observation work while retaining fresh pre-dispatch checks; it is not a benchmark for large projects. The actual Sotto checkout was refused by the documented linked-directory restriction.
