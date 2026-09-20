# Devin native compatibility experiment ? issue 150

Date: September 19, 2026. Status: incomplete; do not register Devin as a supported provider yet.

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

The prompt response denotes turn completion. No live user_message_chunk acknowledgement was observed. Concurrent replay is promising acceptance evidence, but production reconciliation is not implemented or contract-tested.

Permission requests contained a toolCallId; they did not necessarily contain the requested action. The action arrived in an earlier tool_call update. File input used file_path/content; command input used command. An adapter must join the matching update and reject unsupported or incomplete requests. Offered choices included allow_once, allow_always, and reject_once; persistent grants remain outside the spec.

## Permission findings and correction

The session advertised Code (accept-edits), Smart, Ask, Plan, and Bypass. Ask is a read-only conversation mode, not the required approval mode. Launching with --permission-mode normal did not prevent an in-workspace edit. The documented DEVIN_PERMISSION_MODE=normal environment alternative also allowed the Git-project marker edit without a request.

Installed Desktop source has a separate permission-mode configuration selector. Setting configId permission-mode to normal returned success, but its response still advertised mode accept-edits and no permission-mode option. In a Git project, a synthetic file edit then executed without any permission request. Therefore neither that setter nor the CLI flag establishes the required policy.

An earlier test outside a Git project did ask after that setter. It was an insufficient control: later Git-project tests disproved the inference that the setter guarantees approval. Use the Git-project result when evaluating compatibility.

Advertising the source-documented cognition.ai/groupedSessionConfigOptions capability did not expose permission-mode. No permission-specific capability or supported effective-policy readback was established.

A Sotto-owned --config file with ask rules Write(**), exec, Fetch(*), and mcp__* caused the tested edits and echo command to ask. A project-local Write(**) allow without those ask rules allowed the edit; with the ask rules the tested edit still asked. The same test with an Exec(echo) project grant still asked under the custom ask policy. These results cover those actions and this binary, not all scopes, nested configurations, organization policies, native hooks, MCP tools, or runtime configuration changes.

The documented --config flag overrides the user-level config, not all native configuration. Native project and project-local settings still exist. No product integration should claim the temporary profile has established a universal approval boundary.

## Privacy decision needed before integration

The current [CLI Controls documentation](https://docs.devin.ai/cli/enterprise/controls) describes provider-side usage analytics, including model/message/credit activity, tool counts, and generated-line counts. It documents an analytics exception for hybrid deployments. No supported general CLI analytics opt-out was found in the reviewed help, installed configuration reference, or current controls documentation.

Sotto's own no-analytics implementation can remain unchanged. Allowing this provider's separate analytics needs an explicit interpretation of the project's privacy promise, followed by an ADR and README disclosure; the probe cannot silently make that product decision.

Proposed boundary for Zach to review: Sotto adds no telemetry, while an explicitly connected Devin provider uses its own documented processing, persistence, and usage analytics. Keep local history controls only Sotto's copy. Connection guidance discloses this distinction. This does not authorize weaker permissions, automatic approval, credential copying, or undisclosed integrations.

Cognition's [general security page](https://docs.devin.ai/admin/security) describes plan-dependent training controls and retention. It does not establish this signed-in account's settings. The account's actual applicable controls remain unverified; no assumption of training opt-out or zero retention is made.

Configuration imports can be disabled individually, but those switches are not a blanket native-hook or MCP disable switch. Actual required destinations, native persistence/logging behavior, and exclusion of unrequested native integrations remain to be established before an integration ADR can be accepted.

## Remaining acceptance work

- Establish an enforceable and confirmable approval policy across native configuration, resume, and setting changes.
- Complete richer question/cancellation races, terminal-UI takeover, stale follow-up rejection, process-loss recovery, repeated identical prompts, and multiple active threads.
- Establish the account/privacy configuration and actual required destinations.
- Implement the adapter, deterministic fixture/shared contract, existing UI integration, event-store behavior, and working-copy integration.
- Verify native Apple silicon macOS, affected Electron journeys, and visual/keyboard states.
- Run implementation gates and the two-axis review once there is an implementation.

No application source, provider registration, production settings, or user's global Devin configuration was changed. The feature is not implemented, and no supported-platform claim is made. Baseline typecheck passed before these experiments; application gates were not rerun for this documentation-only stage.
