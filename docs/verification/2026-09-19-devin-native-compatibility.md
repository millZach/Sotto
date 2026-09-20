# Devin native compatibility evidence - issue 150

Date: September 19, 2026. Windows native adapter journey passed. Apple silicon verification is deferred by Zach; all Windows validation gates pass; independent review remains pending.

## Environment and boundaries

Native Windows x64, Devin CLI 3000.10.31 (b98cc431), bundled with Devin Desktop under resources/app/extensions/windsurf/devin/bin/devin.exe. ACP protocol 1, client name sotto, client version 0.1.9. Native authentication succeeded after Zach completed browser sign-in. Credential files were not read or copied.

Tests used synthetic text, harmless echo commands, and uniquely named marker files in an OS temporary folder. Later tests initialized that folder as a Git project, which matters for workspace/configuration behavior. Model selection used the account-advertised swe-1-6-fast. Filesystem and terminal client capabilities were false; the CLI performed its own tools.

Only selected capability values, event names, shape/type descriptions, counts, and boolean assertions were emitted. Prompt/response text, protocol bodies, native stderr, account identifiers, and credentials were not logged by the probe. The CLI's own storage and network behavior are separate and were not audited.

## Verified behavior

| Operation | Observation |
| --- | --- |
| Authentication | Native auth status reported signed in; authenticated catalog returned about 385 models. |
| Create | session/new returned a native session ID. Creation alone also succeeds before authentication and does not prove readiness. |
| Model selection | session/set_config_option with configId model returned the requested swe-1-6-fast currentValue. |
| Text turn | session/prompt streamed agent_message_chunk updates and completed with end_turn. |
| Same-session restart | After closing and awaiting the first process, session/load replayed user and assistant messages from the same native ID. |
| Durable authored identity | A UUID in prompt _meta cognition.ai/clientMessageId survived restart and appeared on the replayed user message. A non-UUID token was replaced. messageSubIndex was zero and timestamp was a string. No top-level messageId was observed. |
| Concurrent recovery | While one process held an unanswered permission, another process's session/load replayed the authored UUID before returning lock error -32015. It did not acquire the active session. |
| Cancel while awaiting permission | session/cancel notification ended the prompt with cancelled. The requested file was absent. |
| Deny | With an explicit ask configuration, choosing the offered reject_once prevented the marker file from being created. |
| Allow once | With the same ask configuration, allow_once was selected only after matching the preceding tool call's absolute target and exact synthetic contents. The file existed with the expected contents. |
| Structured question | Advertising elicitation.form as an empty object enabled elicitation/create with mode form and a one-field enum schema. Returning accept with the first offered synthetic choice completed the turn. |
| Separately authored input | A second ACP process loaded the same session and sent a prompt without Sotto metadata. A third load replayed two distinct user UUIDs: the known Sotto dispatch and a new unknown identity. This establishes distinguishable separately authored ACP input, not terminal-UI takeover or a race-free guarded follow-up. |
| Client execution | These tested flows worked without client filesystem or terminal execution. This is not a claim about every optional tool. |

The prompt response denotes turn completion. No live user_message_chunk acknowledgement was observed. The adapter persists a UUID before dispatch, then uses replay of that identity as acceptance evidence. Its scripted subprocess passes the existing adapter contract, including ambiguous delivery reconciliation without resending.

Permission requests contained a toolCallId; they did not necessarily contain the requested action. The action arrived in an earlier tool_call update. File input used file_path/content; command input used command. An adapter must join the matching update and reject unsupported or incomplete requests. Offered choices included allow_once, allow_always, and reject_once; persistent grants remain outside the spec.

## Permission findings and correction

The session advertised Code (accept-edits), Smart, Ask, Plan, and Bypass. Ask is a read-only conversation mode, not the required approval mode. Launching with --permission-mode normal did not prevent an in-workspace edit. The documented DEVIN_PERMISSION_MODE=normal environment alternative also allowed the Git-project marker edit without a request.

Installed Desktop source has a separate permission-mode configuration selector. Setting configId permission-mode to normal returned success, but its response still advertised mode accept-edits and no permission-mode option. In a Git project, a synthetic file edit then executed without any permission request. Therefore neither that setter nor the CLI flag establishes the required policy.

An earlier test outside a Git project did ask after that setter. It was an insufficient control: later Git-project tests disproved the inference that the setter guarantees approval. Use the Git-project result when evaluating compatibility.

Advertising the source-documented cognition.ai/groupedSessionConfigOptions capability did not expose permission-mode. No permission-specific capability or supported effective-policy readback was established.

A Sotto-owned --config file with ask rules Write(**), exec, Fetch(*), and mcp__* caused the tested edits and echo command to ask. A project-local Write(**) allow without those ask rules allowed the edit; with the ask rules the tested edit still asked. The same test with an Exec(echo) project grant still asked under the custom ask policy. These results cover those actions and this binary, not all scopes, nested configurations, organization policies, native hooks, MCP tools, or runtime configuration changes.

The documented --config flag overrides the user-level config, not all native configuration. Native project and project-local settings still exist. No product integration should claim the temporary profile has established a universal approval boundary.

## Accepted privacy boundary

The current [CLI Controls documentation](https://docs.devin.ai/cli/enterprise/controls) describes provider-side usage analytics, including model/message/credit activity, tool counts, and generated-line counts. It documents an analytics exception for hybrid deployments. No supported general CLI analytics opt-out was found in the reviewed help, installed configuration reference, or current controls documentation.

Zach explicitly approved disclosed provider-side analytics on September 19, 2026. [ADR-0017](../adr/0017-devin-native-provider-data-policies.md) records that boundary; Sotto's own no-analytics implementation remains unchanged.

Accepted boundary: Sotto adds no telemetry, while an explicitly connected Devin provider uses its own documented processing, persistence, and usage analytics. Keep local history controls only Sotto's copy. Connection guidance discloses this distinction. This does not authorize weaker permissions, automatic approval, credential copying, or undisclosed integrations.

Cognition's [general security page](https://docs.devin.ai/admin/security) describes plan-dependent training controls and retention. It does not establish this signed-in account's settings. The account's actual applicable controls remain unverified; no assumption of training opt-out or zero retention is made.

The accepted implementation uses a read-back, Sotto-owned ask profile and refuses unverified native integrations instead of treating import switches as a blanket disable. See [policy evidence](2026-09-19-devin-policy.md). A local HTTP CONNECT tunnel, without TLS decryption or payload logging, observed server.codeium.com and o4507463137361920.ingest.us.sentry.io during authenticated discovery and a synthetic turn. These are observed destinations for the tested account route, not a claim about every deployment or the contents of telemetry. Native local records remain outside Sotto's history control.

## Implemented adapter and native journey

The dedicated AgentHost now drives the native ACP subprocess with bounded framing, output, requests, transcript replay, and tool records. Native IDs stay inside the adapter. Sotto history uses ThreadMessageLog, lazy sessions, watched threads, and the idle reaper. Devin is disabled by default on upgrade and remains outside terminal and coordinator catalogs.

The actual host passed `SOTTO_DEVIN_LIVE=1 npx vitest run tests/integration/devinLive.test.ts --maxWorkers=1` on native Windows: account-derived model selection, clean empty-thread restart, streamed text, denied file absent, exact-target one-time allowed file correct, enum question answered, same native session and message identities after a new host instance, and cancellation with the pending file absent. The test records no prompt or protocol bodies. This verifies cancellation while a permission is pending; it does not claim termination of arbitrary background tools spawned before cancellation.

A further native control found that a newly created, empty session has no durable transcript: `session/load` returns `-32016` before the first prompt, both while its creator runs and after it exits. After a prompt, concurrent replay returns history followed by `-32015` (locked). The adapter distinguishes them. Only a confirmed, untouched empty thread after a clean owned shutdown may get a fresh native handle. Dispatch records disable that renewal before transmission. Missing, crashed, or uncertain sessions preserve the thread and report the error; they are never silently recreated.

## Abrupt native process loss (September 20)

The Windows live suite now kills only the ACP process whose command line names the test's unique Sotto approval-profile path, while a file permission is pending. It never approves that action. Both native cases passed in 27.78 seconds during diagnosis; the final native suite passed all 3 cases in 54.10 seconds.

- Before the provider has had a clean shutdown, loading the same native ID reports a different model in both its configuration update and final load response. Sotto preserves the saved model, dispatch identity, and native binding, closes the incompatible owner, and tells the user to restore the original model in Devin or start a new thread. It neither changes the model nor repeats the prompt. The marker file remains absent.
- After a harmless completed turn and clean shutdown/reload, killing the next pending-permission owner allows same-session recovery. The original message identity remains, the old permission answer is rejected, a new harmless prompt completes, and the earlier marker remains absent.

The first attempted prompt asked the model to wait before acting and never reached a permission, so it established no process-loss result. A direct file-tool instruction reproduced the native model mismatch. Temporary content-free diagnostics isolated the model check and were removed. Final loaded settings are now checked outside protocol parsing so their actionable error survives; historical model updates during replay cannot replace that final check. Live model changes and permission-mode guards remain enforced. Deterministic regression tests cover final mismatch refusal and historical model updates.

This establishes behavior for an active turn blocked on permission. It does not prove that arbitrary previously launched external tools stop when the ACP process exits.

## Remaining acceptance work

- Native Apple silicon verification is deferred by Zach's September 20 direction to proceed with Windows only. Windows evidence is not Mac evidence.
- Lifecycle/policy regressions, Electron visual checks, typecheck, lint, notices, and the full suite passed (3,927 tests passed, 34 skipped). Independent Codex reviewers completed both axes and confirmed the findings resolved.
- Record final results and PR status in the implementation plan. No merge or completed issue is claimed here.
