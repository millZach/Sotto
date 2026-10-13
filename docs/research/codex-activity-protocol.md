# Codex activity protocol evidence

Verified September 12, 2026 for #48 against installed `codex-cli 0.154.0` and the T3 reference pinned at `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`.

The [official Codex App Server documentation](https://developers.openai.com/codex/app-server) was searched and fetched through OpenAI Docs. The installed client's generated schemas are the exact wire-shape authority used here. Generate them without starting a turn:

```powershell
codex app-server generate-json-schema --experimental --out .cache/activity-schema
```

The local inspection initially generated `artifacts/native/activity-schema`; those files were moved into the ignored worktree-local `.cache/activity-schema`. Generated files and real user transcripts are not committed. SHA-256 evidence:

- `v2/ItemStartedNotification.json`: `c4c34f47db6326cd4841bae428f23d08eb285077ffad35be9772b928c65bb912`
- `v2/TurnCompletedNotification.json`: `78af2a37391e8e669a4020cb58593e4d3e378756ced79d5fec72374fa69fb94b`

## Native fields used

| Wire source | Retained presentation data |
| --- | --- |
| `item/started`, `item/completed` | Native item ID scoped to native turn ID; lifecycle `startedAtMs` / `completedAtMs` are milliseconds. |
| `commandExecution` | `command`, `cwd`, `status`, `aggregatedOutput`, `exitCode`, `durationMs`. |
| `fileChange` | `changes[].path`, `kind.type`, `diff`, native status. Existing approval summaries remain available. |
| `mcpToolCall`, `dynamicToolCall` | Tool/server labels, text results, status, available duration and error message. Image/audio/encrypted payloads are not copied into activity. |
| `reasoning` | `summary[]` only; `content[]` is deliberately excluded. |
| `item/reasoning/summaryTextDelta` | Visible summary indexed by `summaryIndex`; final `summary[]` replaces streamed text. |
| `item/commandExecution/outputDelta`, `item/fileChange/outputDelta` | Bounded displayed output; authoritative aggregated output replaces streaming when supplied. |
| `plan`, `item/plan/delta`, `turn/plan/updated` | Available proposed plan text or step/status text. Final plan item is authoritative. |
| `collabAgentToolCall` | Native tool label, optional prompt, receiver identities mapped to opaque non-routable display IDs, `agentsStates` statuses/messages. |
| Known child `turn/started`, `turn/completed`, `thread/status/changed` | Update observed child state only. Do not create, resume, subscribe to, or read child transcripts. |
| `turn/started`, `turn/completed` | Status and native turn `startedAt` / `completedAt` in seconds; native `durationMs`, optional error. `AgentThread.lastTurn` exposes completion versus interruption/failure for the queue. |
| `error` | Provider message and `willRetry`; a retrying error does not terminate a turn or release a queued follow-up. |

Native collab states are `pendingInit`, `running`, `interrupted`, `completed`, `errored`, `shutdown`, `notFound`; missing state becomes `unknown`. Child turn outcome can also be `failed`. The generated item union also confirms that reasoning content is an array of strings, unlike user-message content; the old message-only item parser could not safely parse both.

## Reference source inspected

Paths are relative to `.claude/tmp/t3-reference-24` in the main checkout:

- `apps/server/src/provider/Layers/CodexAdapter.ts`, around lines 1738–1860: proposed plan, assistant delta, command/file output, indexed reasoning summary and MCP progress mappings. Sotto adopts the visible-summary path and does not copy raw reasoning.
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`, around lines 1020–1100: collab receiver-to-parent association and separation of child lifecycle from parent conversation notifications.
- `apps/server/src/provider/testFixtures/codexMultiAgentWire.json`, around lines 265–311: actual `collabAgentToolCall` started/completed envelopes with native millisecond lifecycle times and receiver/state maps. New Sotto fixtures are synthetic, shape-compatible records, not copied user conversations.

## Restore, identity and limits

Activity is a separate optional array on `AgentThread`; user and assistant messages retain their original IDs. IDs hash the native turn/item tuple. First observation fixes sequence and message anchor. Lifecycle replay upserts an existing record; terminal records ignore stale starts/deltas. Completed assistant message IDs also reject late starts/deltas, preserving final-answer deduplication.

The existing `WorkspaceHost` cache persists activity, including observation-only timestamps and child states that may not appear in a later native snapshot. Keep local history off strips the entire activity array from saved snapshots and from disabled-history startup. There is no new transcript store, native rollout scanner or recovery side file. Cached unfinished activity restores as unknown until the connected provider supplies live evidence. Native hydration never dispatches work.

Retention is the latest 2,000 records per thread, at most 65,536 text characters per activity across its detail fields, and at most 200 files/agents in a record. Truncation is explicit. Lightweight in-memory identity tombstones prevent rereading an evicted prefix from appending it after recent work. Timestamps absent from historical native items are omitted; a live observed start is marked `timingSource: observed`. A completed turn cannot prove an unacknowledged tool succeeded; such tools remain outcome unknown.

Native delta frames have no event ID or offset. Equal consecutive chunks may be legitimate output, so they are not blindly deduplicated. Completed snapshots are authoritative, and terminal-turn/item guards ignore late delta replay. A duplicate unnumbered delta during an active stream cannot be distinguished from identical legitimate text before an authoritative snapshot arrives.

## Verification boundary

`tests/unit/main/codexActivity.test.ts` covers projection, replay/order/anchors, safe summaries, child isolation, retention and outcome semantics. `tests/integration/codexActivity.test.ts` uses the existing real-child fake App Server and WorkspaceHost to cover streaming, final answers, native history restore, privacy, retries and interruption. The fake optionally persists supplied synthetic item snapshots for native `thread/read` and `thread/resume` replay.

The opt-in installed-client smoke passed on 0.154.0:

```powershell
$env:SOTTO_NATIVE_CODEX_ACTIVITY='1'
npx vitest run tests/integration/codexActivityNative.test.ts --maxWorkers=2
```

It uses an isolated temporary Codex home, connects, registers a project locally, disconnects and reconnects. It creates no native thread or turn, reads no user session, changes no account/configuration, and verifies no native session history was created. This proves the installed transport startup/reconnect boundary, not paid tool execution. The parent owns the coordinated real-tool/skill/queue native journey after integration and the UI lane owns rendered verification. Token/cost reporting remains the later usage ticket.
