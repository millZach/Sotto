# Plan Sotto's Watcher

Date: 2026-10-08. Branch inspected: `command-center`. Status: implementation plan, after voice removal. No implementation, build, test run or commit is part of this work.

## Outcome and acceptance checks

Sotto gets one current **Watcher** on this computer: an ordinary Claude Code, Codex or Grok Build thread on the user's own account, with its provider's own tools/settings, a pinned asking mode and Sotto's thread tools. Its Overview lives in the sidebar. Its conversation lives in the room. Opening a worker opens its real thread pane beside the conversation; **Open in Threads** changes rooms. The sidebar foot is **Dictate | Watcher (owl only) | Threads** everywhere.

This follows [the research and its ideas](../research/2026-10-08-watcher.md), [the voice-removal plan](2026-10-08-remove-voice-control.md), and the A2 room chosen on October 8. Zach's October 9 owl and wording picks come from the [approved owl mock-up](C:/Users/zache/AppData/Local/zstack-scratch/owl-prototype/), which remains outside the repository. Opening a worker stays beside Watcher in this room; narrow widths use tabs. Stop all asks before stopping only eligible threads Watcher started. No second window, Overview rail, voice or Agents room is planned.

The implementation is done when these checks hold:

- A restart finds the same current Sotto thread, without finding it by title or launching a second master. Devin workers are available, but Devin cannot be chosen for the master.
- The master reads and searches natively with its ordinary provider's reach. It keeps native tools and inherited servers; its own edit/command requests use normal cards. Its guidance asks it to coordinate through worker threads. Sotto supplies no project-file broker.
- Tools use the coordinator's existing creation, send, queue, steer, interrupt and settle paths. Retries cannot create a second worker or deliver a prompt twice.
- Questions and permissions are answered only on the target thread's own request card. A tool call, imported history, wake-up or “go ahead” never answers one or widens permissions.
- Main enforces four threads in flight initially and a bounded number of prompts per thread per user request. Takeover and Stop all fence subsequent delivery, including work already waiting in a lane.
- Main wakes the master from observed changes, in batches. The model does not poll. Observations have their source and time; a worker's claim is separate.
- The A2 room works from the keyboard, in light and dark, with reduced motion, at 1600x1000, 1280x800 and 820x560. At the minimum, open panes become tabs with their drafts and reading positions intact.
- Keep local history off writes no Watcher message or file content to Sotto's stores, queues, backups or logs. Text-free identities and delivery evidence survive restart without replaying an uncertain prompt.

These checks extend the surviving `AgentControl`, `WorkspaceHost`, `ThreadStore` and renderer thread state. They do not restore the deleted assignment or attention machinery.

## 0. Land voice removal first

Ticket 0 is [the removal plan](2026-10-08-remove-voice-control.md) and ADR-0068. Its finished tree has no voice coordinator, Agents room, `voiceCoordinatorEnabled`, assignments, attention queue, `reasoning.intent` or `decide`. Old saved fields are migration input, not authority for Watcher. Inert host-v1 compatibility fields remain only where that plan requires them.

Keep the removal's retained paths: `src/main/agents/control.ts` and its command lanes, outbox and delivery receipts; provider adapters; `followups.ts`; `babysitting.ts`; `wakeUp.ts`; scoped thread tool servers; native takeover observations; and the text-free turn recorder. Keep dictation and memory on their existing paths and gates. Watcher has no voice gate and uses no dormant coordinator reasoning account. Model and title side calls remain on the thread's provider under ADR-0026.

Source files were being edited for the removal while this plan was read. File and symbol references below name retained boundaries or explicit new work; they are not instructions to retain a deleted field because it appeared in the old checkout.

## 1. Watcher thread

### Identity, creation and recovery

Add an optional thread kind to `src/shared/agents.ts` and the saved workspace schema in `src/main/agents/workspace.ts`: ordinary threads default to `project`; special records distinguish the current Watcher and retained Watcher history. Main's Watcher record names the current local Sotto thread ID, local computer/host identity, project ID, provider and creation operation. There is exactly one current reference in the local user-data store, not one per selected host, project or window. A paired headless host does not acquire a master because this desktop connects to it.

Implement `WatcherService` in proposed `src/main/agents/watcher.ts`. Before creation, persist a text-free creation intent and its minted UUID. Then use `AgentControl`'s `create-thread` path with that UUID, record the special kind, flush its `ThreadRegistry` binding, and admit the tool token before the first `manual-send`. Recover those steps by the existing creation receipt and intent after a crash. Conflicting kinds or references produce a recovery notice and no process; never adopt a user's thread by its title. A token is minted for the recovered live session, not restored from disk.

This follows `coordinatorSetupThreads()` in `src/main/hosts/hostSetupThreads.ts`, `HostSetupToolServer.mcpServer()`/`invoke()` in `hostSetupTools.ts`, and [ADR-0035](../adr/0035-an-agent-can-set-up-a-host-from-add-host.md): create an ordinary project thread, then admit its special tools before its first send. Host setup's in-memory job ends and leaves an ordinary thread; Watcher needs a durable kind and admission across restarts. Watcher pins its native asking mode and excludes host-setup tools.

Use `<userData>/watcher/workspace` as a neutral Sotto-owned working folder, registered as a special project through the existing provider/project creation boundary. Sotto may create its own launch configuration there. It is not a user's repository, a worktree or a roaming current project. Hide the special project from normal new-thread choices. Reads of real projects use native provider tools; do not add every project as a writable workspace or copy project instructions into this folder.

`ThreadRegistry.reserve()` in `src/main/agents/threads.ts` refuses rebinding an ID to another provider/session, and CONTEXT's **Thread binding** keeps historical ownership. Keep that invariant. The recommended provider-change flow creates a replacement current master with a new Sotto ID, retires the previous conversation into readable Watcher history, revokes its tools, and atomically changes the current reference. There is one current master, with its earlier conversations retained according to history settings. Do not silently move a native conversation between providers. The continuity choice is listed for Zach in section 12.

### Provider, model and effort

Offer Claude Code, Codex and Grok Build through their ordinary native account readiness and model catalogs. Follow the existing new-thread model/effort defaults where available. Devin remains refused because its adapter cannot attach scoped servers; there is no OpenRouter or new-key fallback.

Reuse ModelPicker, EffortPicker and configure-thread for the master. Model and effort changes stay allowed while idle. Display its permission as **Ask before changes**, without a widening action. Main and the adapters reject runtimeMode/providerMode widening and working-copy changes in plain words. Its own questions and permissions use normal request cards, answered only by the user. Ordinary workers retain their controls. Provider replacement still waits for in-flight work to settle, creates a new Sotto/native identity and offers a bounded visible handover after the user's choice; worker ownership and receipts survive.

### Pinned provider modes and native tools

Select the internal Watcher launch profile only from main's durable current identity, never a tool argument, prompt, phone or host command. Keep the identity cache, failure isolation and history-resume refusal. Native provider tools, the user's own settings and servers remain available as on ordinary threads. Add Sotto's visual and pull-request servers; filter out Sotto's browser and host-setup servers from both attachment and exact admission.

| Provider | Pinned mode | System prompt |
| --- | --- | --- |
| Codex | Read-only sandbox, on-request approval policy, user reviewer at process launch and all thread/turn/settings routes. Do not use ordinary approval-required/untrusted: Windows shell reads then ask. | Developer instructions alongside the project instructions codex.ts already resolves. |
| Claude Code | Native manual/default mode and host/stdio permission callbacks. Read, Grep and Glob run freely; edit and command permissions follow native default rules and inherited allow rules. | Supported --append-system-prompt on every new/resume/early-start/replacement process. |
| Grok Build | Ordinary default mode with ACP yoloMode=false and autoMode=false. No isolated home or ToolConfig. | Pinned protocol's _meta.systemPromptOverride on session/new and session/load. _meta.rules alone is creation-only. |
| Devin | Plain refusal while mcpServers stays empty. | No prompt-only fallback. |

Put Sotto's Watcher guidance in its own module: coordinate through sotto_threads, start or brief threads rather than editing/running work itself, read/search natively as needed, never answer a thread's question or permission, and say what was sent to which thread. Apply it on launch, resume, cold load, early start, settings/model change and replacement processes. Guidance is not enforcement. The native pinned mode, scoped tool identity and tools that answer nothing enforce the boundary. Native read reach and inherited customization/server permissions remain those of ordinary provider threads; no containment or secret-filter promise remains.

### Calling Sotto without native confirmation

Extend `ThreadToolDefinition` and `ThreadToolResult` in `threadToolServer.ts` with strict output schemas, structured results and appropriate MCP annotations. Follow `pullRequestTools.ts`/`visualTools.ts` for loopback tokens, revocation and repeated admission checks. Claude's `toolAllowance()` names the exact `mcp__sotto_threads__*` tools. Codex's `threadConfig()` sets the offered tools' approval mode to approve. Grok's `toolAdmission()` admits only this thread's offered server and exact names, and the launch instructions name the full discovery names to avoid extra discovery confirmations.

This native preallowance permits a call to the Sotto boundary. It grants no worker permission. The master's own native permission requests use normal request cards; interrupting or answering one does not retire the master or widen its pinned mode. The master's own question cards belong to the user, as do every worker's question and permission cards.

## 2. The `sotto_threads` contract

### Common boundary

Implement proposed `src/main/agents/watcherTools.ts` over `ThreadToolServer`, with strict schemas in proposed `src/shared/watcher.ts`. Use [T3 Code's V2 orchestration contract](https://github.com/pingdotgg/t3code/blob/393ff4c968073d8419e5bade06000998602af6ad/docs/orchestration-v2/orchestrator-mcp-server.md) for app-owned identity, bounded reads, shared command services and stable request keys. Add idempotency to creation as well as sends. Omit T3's waiting/polling and permission-changing operations.

All target identities are `{hostId, threadId}` or `{hostId, projectId}` using Sotto IDs on the owning host. Do not accept provider session IDs, ambiguous selected-host fallbacks, arbitrary working directories, shell commands or serialized `AgentCommand` objects. Each mutation includes `requestId` and `retryKey`; main creates request IDs from actual user submissions to the current master's composer. The caller can select an admitted request ID, but cannot mint one or reopen a stopped request. Wake-ups, compaction and tool calls create no new prompt budget.

Every result is either `{status:'ok', ...}` or `{status:'refused', code, message, retryable, ...}`. Delivery-bearing results also carry `operationId`, target, request ID, delivery state and a receipt/card ID. `accepted` means the provider acknowledged delivery, not that the work succeeded. `queued` means saved or, with history off, retained for this live session. `uncertain` means reconcile, never resend. Typed refusals are stable program values; UI copy says what happened and what to do, without displaying codes.

Common refusals: `NOT_CURRENT_WATCHER`, `REQUEST_NOT_ACTIVE`, `UNKNOWN_TARGET`, `HOST_DISCONNECTED`, `HOST_FEATURE_UNAVAILABLE`, `PROVIDER_UNAVAILABLE`, `READ_ONLY_PROFILE_UNAVAILABLE`, `INVALID_INPUT`, `RETRY_KEY_CONFLICT`, `THREAD_TAKEN_OVER`, `PENDING_USER_REQUEST`, `TARGET_CHANGED`, `DELIVERY_UNCERTAIN`, `IN_FLIGHT_LIMIT`, `PROMPT_LIMIT`, `PERMISSION_TOO_WIDE`, `PERMISSION_NOT_COMPARABLE`, and `RESERVED_THREAD`. No handler relies only on `tools/list`: the current server's call dispatcher knows global definitions, so `invoke()` must check caller admission and capability again.

The highest-risk code paths are permissive provider fallback, inherited startup/MCP tools, privilege borrowed from local IPC, takeover racing a provider write, and machine text leaking through durable drafts/queues. Their refusal, dispatch and privacy checks belong in these boundaries and the owning tickets; they are engineering acceptance conditions.

Proposed concrete bounds: UUID retry keys; 32 KiB UTF-8 prompt text; 512-character titles; 100 rows per roster page; 50 messages and 64 KiB total per thread read; at most 8 active tool calls per master within `ThreadToolServer`'s existing global limits. Reject oversized arguments before dispatch. Reads use no coordinator command lane. A mutation releases its admission lock before awaiting a provider. Tokens remain in memory, scoped to master session/generation, and expire on retirement, shutdown or failed profile validation.

### Tools

The names below are MCP tool names inside `sotto_threads`. Read tools have deterministic cursors and need no mutation retry key; their explicit retry-key entry is **none**. Common refusals apply in addition to those named in each row.

| Tool | Inputs | Output | Refusals, retry key and limits |
| --- | --- | --- | --- |
| `list_threads` | Optional host/project/group filters, `includeSettled` (default true), opaque snapshot cursor, `limit` 1..100. | Rows with host/Sotto IDs, title, project/provider/model/effort, status, group, waits-on request descriptors, branch/working copy, linked PRs, evidence, last observed activity, connection freshness, user-read time and Watcher read time. Include participation, started-by and takeover marks; `snapshotRevision`, `observedAt`, `nextCursor`, counts and stale hosts. | No full request bodies or transcript. `CURSOR_EXPIRED` returns a restart cursor. Retry key none. Exclude current/retired masters; include other special jobs as readable but protected. Never clear Finished unread. |
| `read_thread` | Target, optional `{historyEpoch, afterPosition}`, `limit` 1..50 and optional activity summaries. First read without position returns a bounded recent window. | Messages with IDs/positions, pending request descriptors with open-target references, bounded activity/evidence, first/last/next positions, epoch and `truncated`/`earlierAvailable`. Update only Watcher read metadata. | `HISTORY_RESET` returns a new cursor rather than merging epochs; `HISTORY_UNAVAILABLE` distinguishes empty from unavailable. Retry key none. Cap response at 64 KiB; do not change the user's pane history window or reading mark. Native refresh follows existing adapter reads, not a new transcript import loop. |
| `start_thread` | `requestId`, `retryKey`, host/project, supported model/effort, optional explicit permission, working-copy choice (`shared`, `new-worktree`, `existing-worktree` by host-issued choice ID), optional allowed base ref, title and first prompt. | Stable new Sotto ID, effective choices, creation receipt, first-prompt receipt and delivery state. Return the created target even if first delivery fails or is uncertain. | Additional `WORKING_COPY_UNAVAILABLE`, `WORKING_COPY_CHANGED`. Permission must be no wider than the user's effective new-thread default for that project/provider at admission and dispatch. If omitted use that default; if it cannot be compared, refuse. Retry identity reserves both thread UUID and first-message UUID before creation; same key/digest resumes or reports them. Capacity reservation and first prompt count are atomic. No arbitrary existing-worktree path, new project or worktree reclaim. |
| `send_to_thread` | `requestId`, target, `retryKey`, text, `delivery:'now'|'queue'|'steer'`, optional expected last-user-message ID and expected turn ID. | `operationId`, stable draft/message/item IDs, effective delivery mode, `queued`/`accepted`/`failed`/`uncertain`, capacity/prompt counts and receipt. | Additional `THREAD_BUSY`, `STEER_UNAVAILABLE`, `TURN_CHANGED`. Never convert now to queue/steer silently. Any pending question/permission blocks all three modes, including one that appears before dispatch. Existing user-authored queued items remain first. Count each distinct admitted prompt once; retries count zero. Steer requires the same confirmed running turn and provider capability. |
| `stop_thread` | Active request, target, retry key. | Interrupt receipt and observed state; distinguishes requested stop from confirmed stopped, with outstanding background work and uncertainty. Record the target/action against the user's request even if it was an existing thread. | `THREAD_TAKEN_OVER` for a relinquished participation; `RESERVED_THREAD` for the master or a protected job. Maps to `interrupt`; pause/cancel only Watcher-owned pending sends before it. Same key returns the same stop operation. It creates no prompt. Unlike the user-only Stop all, a targeted stop can address an existing ordinary thread within the user's request. |
| `settle_thread` | Active request, target, retry key. | Settled state and command receipt, preserving the thread and working copy; record the request/target action. | `THREAD_BUSY`, `PENDING_USER_REQUEST`, `DELIVERY_UNCERTAIN`, `BACKGROUND_WORK_RUNNING`, `THREAD_TAKEN_OVER`, `RESERVED_THREAD`. Maps only to `settle-thread`. No stop, delete, forget, branch reset, merge or worktree reclamation. Same key is idempotent. |
| `list_projects` | Optional host, cursor, `limit` 1..100. | Known project IDs, titles, readable roots as display information, available worker providers/models/default permissions and host feature/pinned-mode availability. | Retry key none; roots are not filesystem capabilities. Special internal projects are excluded from start/read choices. A disconnected host is reported stale, not inferred empty. |
| `list_working_copies` | Host/project and optional cursor/limit 1..100. | Shared/new-worktree choices, bounded eligible existing worktrees and base refs, host-issued choice IDs/revisions, branch/occupied/locked state and limitations. | Retry key none; `WORKING_COPY_UNAVAILABLE` and stale-choice refusal. Uses `WorkspaceHost.workingCopyOptions()`/`ThreadWorktrees.options()` and existing Git-ref reads without remote fetch. Choice IDs resolve only to a known worktree of this project and are revalidated at start; no free-form folder capability. |
| `read_operation` | Operation ID from this master's admitted request. | The existing creation/delivery/stop/settle receipt, current target state and limits. | `UNKNOWN_OPERATION` or wrong owner. Retry key none. Recovery/debugging read, not a wait API or invitation to poll. Wake-ups carry changed receipt IDs. |

Do not add answer, approve, configure permissions, assign, resume management, merge, terminal, arbitrary execution or generic command tools. User-only Stop all and provider/model changes are main/IPC operations, not extra capabilities of the model.

### Mapping onto the coordinator

`AgentControl.commandShell()`, `commandWhileRunning()`, `commandUnreserved()` and `sendManual()` in `src/main/agents/control.ts` remain the delivery boundary. Add an internal execution context such as `commandFromWatcher(command, origin)`, with a closed command union and a main-minted origin. It calls those paths rather than implementing another provider writer. The context also selects **do not change the user's selection**: `create-thread` currently takes selection, and remote creation can select a new thread in `DesktopHostRouter`. A tool must not pull the user away from a pane or project.

| Tool action | Existing command | Lane and receipt behavior to retain |
| --- | --- | --- |
| Create worker | `create-thread`, then `manual-send` | Creation uses the global creation lane and flushes Sotto identity before native dispatch. First send uses that thread's lane and the normal outbox. The combined operation survives a gap between these two commands. |
| Send now | `manual-send` | Per-thread lane; `promptAdmissions`, `followupDigest`, read before a send and stale-last-user recheck; normal message ID, outbox and `deliveredDrafts`. |
| Queue | `queue-followup` | `FollowupStore`'s mutation lane; normal item ID and follow-up receipt, then `pumpFollowups()` uses the same native send/outbox path when ready. |
| Steer | `steer` (or `steer-followup` only for its own queued item) | Per-thread lane, running-turn/capability recheck, normal steer delivery evidence; never steer the user's queued item. |
| Stop | `interrupt` | Existing lane-bypassing interrupt; fence new automation first, then reconcile its receipt. No global wait behind another host/provider. |
| Settle | `settle-thread` | Existing thread lane and `WorkspaceHost.setWorkspaceSettled()` organization. No destructive cleanup or reclaim prompt. |

`src/shared/threadLanes.ts` already makes creation global, sends/steers thread-scoped, follow-up edits independently serialized and interrupt immediate. Extend that arrangement with a short Watcher admission transaction for limits/ownership, not a long model or provider lock. Keep existing selection revision safeguards.

The generic `compose`/`send` path can bind a draft to a pending question, and `guardClientGrant()` currently treats a local IPC client as able to grant. Machine-origin commands must enter neither privilege. Reject `answer`, request bindings, `approved`, `permissionChoice`, policy changes and arbitrary unknown fields at schema validation; the execution boundary checks them again. `sendManual()` and the queue/steer dispatcher check pending requests, ownership generation and default-permission bounds after awaits and immediately before the provider writer. A Sotto tool confirmation is not permission to answer a child. Remote enforcement repeats these checks at the owning host.

Add a forward positional read to `ThreadStore` rather than misusing its existing backwards pane-window pagination. Keep message position, history epoch and global event sequence separate. For providers without event support, use the host's existing bounded projection/refresh boundary and report unavailable history explicitly. Roster pagination is over a pinned snapshot revision; a stale cursor restarts cleanly without mixing pages from different host states.

The user's request authorizes bounded start/send work under ADR-0071; this is a new explicit policy decision, not revived supervision. Main can enforce target identity, scope of tools, permission ceilings, budgets and takeovers. It cannot prove that every generated brief faithfully interprets natural language. Preserve the original request reference, show every action and allow Stop/takeover; do not invent a second semantic reasoner or claim one is an authority check.

### Native project reads

There are no project-file tools or project-read broker. Watcher reads and searches using its provider's native tools, with the ordinary provider's filesystem reach and settings. Sotto's thread tools read roster/thread/operation evidence, not arbitrary files. Remote thread evidence uses the owning host's optional read feature; no file broker or file protocol is added.

## 3. Main's record, limits and takeover

Use the existing stores for their existing purposes. Do not add another transcript JSON file or turn this into assignments.

| Location | Proposed data | Privacy and recovery |
| --- | --- | --- |
| `workspace.json`, managed by `WorkspaceHost` | Special thread kind/current-or-retired role, display options, read marks and ordinary organization. Existing thread options hold model and effort. | No messages. Kind defaults preserve old stores. Keep current identity linked to the main record; a title is never identity. |
| `threads.json`, managed by `ThreadRegistry` | Ordinary Sotto/native bindings for each current or retired master and worker. | Keep ADR-0002's flush-before-dispatch and no cross-provider rebinding. Never persist tokens. |
| `agents.json`, managed by `AgentControl`/its strict saved schema | A versioned `watcher` record: current reference/creation phase, request IDs and root user-message IDs, request state, operation/retry-key/digest references, worker targets, `startedBy`, ownership generation, prompt counters, takeover reason/time, reservations, receipt links, last wake/read positions. Existing outbox/delivery receipts stay the dispatch truth. | Text-free durable control metadata survives history off. Migrate before strict parse. Store no copied request, brief, transcript, raw provider body, path contents or error prose here. Reconcile uncertain operations; never replay them because the master asks again. |
| `threads.sqlite`, managed by `ThreadStore` under ADR-0016 | Normal master and worker messages; proposed receipt/card side table anchored to master message/tool-call IDs; bounded evidence payloads that need text, and read positions. | Follow the existing ephemeral store when history is off and history purge/retention when it changes. Store references once, not a second prompt copy. New side tables must participate in forget, rewind and privacy cleanup. |
| `FollowupStore` | User queue items plus machine-origin queued sends/wake-ups with ownership/request/generation and receipt references. | Existing `followups.json` stores words. New Watcher text must be history-aware: memory only with history off, never leak through `agents.json` drafts, serialized queue snapshots or backup files. Text-free item identities can persist for uncertainty/reconciliation. |

For “what was sent,” retain operation and message IDs, a content digest, target, delivery mode, timestamps and state. With history on, resolve the prompt from its normal message/queue record. With history off, resolve live text only in memory; after restart say the text is unavailable. The record cannot promise to reproduce content it deliberately did not save. Stable event names alone enter logs and turn records. Errors and telemetry do not get prompt text, file content, bearer tokens, tool arguments or protocol bodies.

`ThreadStore` already has separate visuals and `wake_ups` tables, and `WorkspaceHost.decorateMessages()` reattaches them when native history is read. Use that pattern for cards: a message reset can change an anchor's presentation without losing the durable operation's receipt. A rewind must not erase that a worker was created or resend it. Redacted text remains redacted. Do not invent an `answer-given` event for a tool action; only actual user answers retain that attribution.

### A request and its budgets

A **Watcher request** starts with an ordinary top-level user Send to the current master, with a main-minted ID and the actual root message identity. User queue/steer input attached to that turn and answers to the master's own question retain its request ID. An ordinary later top-level Send is a new user request; main uses this observable command boundary, not a semantic guess about whether the text is a clarification. Tool calls include an active request ID; asynchronous wake-ups name the relevant existing requests. Do not reset budgets on a wake-up, retry, model change, restart or compaction. Only an actual new user Send creates another request; “go ahead” still answers no worker question or permission, whichever request ID it has.

The master's turn ending does not close a request that still has participants: it must be able to receive their events and send bounded follow-ups under the same budget. Main closes it after an explicit user stop, or when all its participants are settled/relinquished and no delivery remains outstanding. A purely conversational request with no participant/operation can finish with the master turn. Closed requests cannot be revived by the model or by restoring a settled worker. Retain necessary operation/retry identities and a closed-request fence even when transcript history is unavailable.

Default in-flight limit: four, computer-wide across this master's requests and hosts. A slot is occupied by a creation reservation, an active automated turn or confirmed background work, a queued/dispatching prompt, an uncertain delivery, or a worker waiting on a user request in that automated turn. Hold the slot for a pending question/permission; it is not idle capacity for starting replacements. Release when the turn is finished and there is no such outstanding work. A PR left open alone does not occupy a slot. Rebuild from receipts and fresh observed native state after restart; an unknown/disconnected active operation retains its slot until reconciled.

Count distinct automated target threads, including existing threads the master sends to, once each. Exclude the master and unrelated manually running threads. This prevents bypassing four by sending to many existing threads. The record separately distinguishes **started here**, because Stop all has the narrower decided scope. The meter uses this count; its accessible description includes waiting/queued/uncertain items rather than pretending they are all running native turns.

Recommendation for the fixed per-thread/per-request prompt cap: four total, including the first prompt. Now, queue and steer each consume one distinct admitted prompt; retries do not. Definitive pre-dispatch refusal consumes none, but an admitted/uncertain delivery keeps its reservation so ambiguity cannot buy another prompt. Cancellation after admission does not recycle the prompt budget. This is a new constant, not the voice coordinator's deleted `followupLimit`. On exhaustion return a receipt and tell the user; the master cannot reset or increase it.

### Takeover and stop

Reuse the retained native-origin observations in `control.ts` and adapters, plus an explicit user-origin check on desktop/phone sends. When the user submits an ordinary instruction directly to a participating worker, mark takeover before its send is queued. Also detect a new native user message without the matching Sotto command/message identity. Increment ownership generation, fence subsequent Watcher delivery after every await, remove only its not-yet-dispatched machine queue items, and publish a text-free takeover event. Do not delete the user's drafts/queue or interrupt the user's newly started turn.

Opening, reading or editing an unsent draft is not takeover. Answering the worker's actual request card remains the intended answer flow, not an ordinary instruction; its attributed `answer` path does not revoke participation. A plain-question answer bound by the user UI is still an answer. A normal composer send without that binding is takeover. The tool server cannot create such bindings. Direct user stop/settle/reconfiguration also fences automation so it cannot undo the user's action.

The master says **You took over [thread]. I stopped sending to it.** This statement is backed by main's receipt, even if the model fails to mention it. V1 has no model tool to resume ownership. A new prompt to the master alone does not erase takeover; continuing that worker needs a future explicit user action, or the master starts another worker within a new request.

Stop all's confirmation lists the eligible started-here targets and hosts. On confirmation, main stops admission for the affected active requests, cancels their undispatched machine prompts, rechecks takeover/ownership, and dispatches normal `interrupt` operations to the still-eligible started threads. It does not stop the master, user-started targets, taken-over targets or unrelated provider subagents. Report partial/disconnected/uncertain results individually. Suppress wake-ups that would replenish the stopped request. The master's normal Stop control remains the ordinary way to stop its own turn.

## 4. Waking Watcher

Extend `AgentControl.deliverWakeUp()`/`withdrawWakeUp()`, `FollowupStore.queueWakeUp()` and `pumpFollowups()` rather than creating a second writer. Today those methods accept `BabysitNews` from `babysitting.ts`, worded by `wakeUp.ts` under [ADR-0061](../adr/0061-a-thread-can-babysit-its-pull-request.md). Generalize the stored news as a discriminated source: existing `pull-request` news keeps its behavior; new `watcher` news carries request/target/generation and event identity. Share queue ordering, immutable Sotto items, outbox, marking and the checks before claim and before dispatch. Do not put worker changes into fake pull-request records.

Subscribe to retained host/workspace/coordinator observations for threads the master started, and participating existing threads it sent to. Keep this background watch distinct from the set of panes actually read by the user. `observe-threads` currently supports the UI's watched set; form the provider-residency union without clearing Finished unread for automation. Connected hosts already stream shell/detail changes. The master never runs `list_threads` on a timer or stays in a wait tool. Existing native adapter observation and babysitting's GitHub reads remain their own mechanisms; this feature adds no periodic roster/GitHub poll.

| Event | Trigger and contents | Deduplication/validity |
| --- | --- | --- |
| `turn-finished` | A confirmed foreground terminal transition, target/request/turn/message IDs, time, remaining background work and evidence references. | Once per turn/generation. Finished is not reviewed or merged. |
| `needs-user` | A new pending question or permission: target, request-card ID and kind, time, **Open to answer** reference. No synthesized answer. | Once per request-card revision; withdrawn if answered before dispatch. Never copy a permission into an actionable master card. |
| `turn-failed` | Confirmed failed turn, stable failure category, evidence/error reference and time. | Coalesce with completion of that turn; actual bounded error available through read_thread according to history. |
| `quiet` | An active participating thread has had no real message/activity/background-work progress for 20 minutes. | A cancellable one-shot deadline, not polling; one event per quiet episode. Reschedule from actual activity, not shell republishing. Pending requests, disconnection and unsupported observation are not quiet. |
| `taken-over` | Main fences a worker due to direct user input or user control. | Ownership generation makes it final for that participation. Deliver as information, with no resume affordance for the model. |
| `delivery-changed` | A queued/uncertain operation gets definitive receipt evidence. | Once per changed delivery revision. Lets the master learn resolution without polling receipts. |
| `evidence-changed` | A linked PR/check/landing observation changes through existing babysitting/Git surfaces. | Source fingerprint/head/time, not duplicate comments or every timer pass. |

Batch for two seconds from the first pending event, with a maximum five-second delay during a sustained burst. Fold by target/turn/request, keeping the newest truth: a question answered before dispatch is removed; failure wins over a generic finish; takeover wins over instructions to send; a new PR head invalidates prior-head check evidence. Include at most 50 targets and 16 KiB of Sotto-worded news in one wake-up, with an omitted count and roster reference. Several events become one queued message. While the master is busy, fold into its one waiting Watcher wake-up; the user's queued messages remain before it. If it is stopped or waiting on its own request card, queue news without answering or restarting a stopped request.

A quiet deadline after restart is based on fresh connection/observation, not an old timestamp treated as proof of silence. Reconcile pending event IDs and delivery receipts before scheduling recovery news. With history off, keep news words in memory and rebuild only text-free current observations after restart. Never restore lost prose from a prompt copied into metadata.

Babysitting wakes a worker about its own GitHub PR, can end after its comment cap, and has a two-minute read pass. Watcher wake-ups describe changes across its participants, use event subscriptions/deadlines, and have no GitHub read loop or comment quota. The center does not need the pull-request tool server or `gh` to consume that evidence. Babysitting started by a worker remains that worker's service and permission boundary. Stop/retirement/takeover generation checks make stale Watcher news inert without withdrawing independent babysitting news.

## 5. Evidence, separately from a worker's words

Add a bounded evidence projection to the shared contract and host shell/detail optional fields. Every item names `source`, `observedAt`, target, turn/head/checkpoint identity where applicable, freshness and availability. The roster and wake-up carry references and short facts; `read_thread` can provide the bounded underlying detail. The UI presents **Sotto saw** separately from **The thread said**. Neither a checks-passed item nor a confident reply authorizes merge or approval.

| Evidence | Existing source and required addition | Honest limit |
| --- | --- | --- |
| PR and checks | `babysitting.ts`/`githubBabysitReads.ts` already read through the host's signed-in `gh`, and retain `lastReads`. Publish a typed successful-read snapshot/callback, shared by URL and PR head, for checks/review/merge state. Use `gitStatus.ts`/`src/shared/gitStatus.ts` for the branch's PR link and `readAt`/`fetchedAt`. | No extra center poll or comment-body import. Failed/rate-limited/stale reads say so. A PR no service has read has unknown checks, not zero failures. Github review approval is distinct from the user's permission to merge. |
| Turn changes | `connectCheckpoints()` in `src/main/tools/checkpointIntegration.ts` installs `WorkspaceHost.setCheckpointHooks()` and calls `CheckpointService.afterTurn()`. Publish completed checkpoint file counts; compute bounded insertions/deletions only when reliable text before/after is available. | `src/shared/checkpoints.ts` presently exposes changed-file entries, not turn line counts. Do not claim those counts already exist. Interrupted/unsupported captures and concurrent edits in shared copies prevent clean attribution. Keep the checkpoint's unavailable reason. |
| Current checkout changes | `GitStatusReader`/`GitStatusSource.read()` in `gitStatus.ts` expose `changedFiles`, `insertions`, `deletions` and branch. Use existing snapshots or an explicitly bounded local status read with remote fetch disabled. | Label **Working copy**, not **This turn**, where other threads share the checkout. A read tool does not fetch or mutate refs to make evidence fresher. Remote/headless hosts can supply this evidence even without desktop checkpoints. |
| Failure | Confirmed native turn error/status in adapter snapshots and bounded `AgentActivity` details in `src/shared/agentActivity.ts`/ThreadStore. Publish stable category and IDs; show/read error prose transiently under history policy. | Provider-reported command/exit-code activity is still provider-reported. Sotto independently observing the failed turn does not prove it ran a test itself. Do not store raw protocol errors, command output or file contents in control metadata/logs. |
| Delivery, takeover and user approval | Main's outbox, delivery receipts, user-origin answer records and ownership generations. | These are Sotto-observed operations. An assistant message saying “approved,” a queue item or “go ahead” in the master is not one. |

Overview's Landing group needs a real approved landing action or observed merge/auto-merge state from the existing Git/PR surfaces. Do not infer it from the worker's prose. Source-specific approval labels must distinguish GitHub review approval from Sotto's user-approved action. No master tool performs that action.

## 6. A2 room and the beside pane

### Approved owl and words

Zach chose the name **Watcher** on October 9, 2026. Watcher is a bare name, shown as Sotto's owl. The source of these picks is the [approved owl mock-up](C:/Users/zache/AppData/Local/zstack-scratch/owl-prototype/); it stays outside the repository.

- The owl, icon only, sits in the sidebar foot switch between Dictate and Threads. Its tooltip and accessible name are **Watcher**.
- A watched thread shows the owl right after its provider logo in the sidebar row and pane header, in the row's muted text colour. Teal belongs only to the Sotto Owl header tile and the switch while Watcher's room is open.
- The badge's tooltip and accessible name are **Watched by Watcher**. The pane-header owl is an image, not a control.
- The watched thread's composer says **Watched by Watcher. If you send here, Watcher stops sending to it.**
- The room header's limit reads **3 of 4 watched**. Stop all asks **Stop the 2 threads Watcher started?** with the actual eligible count.

### Shell and Overview

Extend the post-removal navigation union in `src/renderer/src/state/AppContext.tsx`, `App.tsx`, and `components/AppShell.tsx`'s `AppRoom`/`roomFor()`/`layoutFor()`. Add the third room to the single switch definition used by every sidebar foot. `SidebarFoot` in `agents/SidebarFrame.tsx` already has a tablist with roving focus, arrow keys, Home and End. Keep one tab stop, selected state and predictable focus after activation; test all three tabs from Dictate, Threads, Settings, Help and Memory. No shortcut is needed for v1; any added later must check the global dictation hotkey first.

Reuse `SidebarFrame`, `SidebarTop`, foot, connection indicators and resizing. Add an Overview header/list variant rather than exposing Threads/Terminals mode or “New thread” actions in this room. Reuse the thread-state selectors and row facts from `ThreadSidebar`/`threadFacts`/workspace organization; do not mount another ordinary project list or create a second attention queue. Put shared grouping logic in proposed `src/shared/watcherOverview.ts`, consumed by tools and the renderer.

Overview lists every other thread across the connected desktop router, including user-created threads. Settled/archived entries remain reachable in a collapsed Idle subsection. Current/retired masters are excluded; active host/provider setup jobs can be seen but are protected from sends/stops. Groups appear in the decided order, with counts, per-row host and last activity, pending-request names, ownership/takeover and **Read [time]**. Distinguish **Read by you**, **Read by Watcher** and **Observed [time]** in detail/accessible text. Machine reads do not mark a thread read for the user.

Grouping precedence is deterministic: pending question/permission or failed turn goes to Needs you; a verified landing action goes to Landing; another open PR goes to Ready for review; active work past the quiet deadline goes to Quiet; other active work goes to Working; otherwise Idle. Display order stays Needs you, Ready for review, Working, Landing, Quiet, Idle. A disconnected host is marked unavailable with stale time, not reclassified as a failed or quiet turn. Failure remains visible until a new turn/recovery resolves it. Group labels describe what Sotto knows, not what an agent claims is done.

### Conversation and cards

Build proposed `src/renderer/src/watcher/WatcherView.tsx` and `WatcherOverview.tsx`. Reuse `ThreadPane`, `ThreadComposer`, `ThreadTranscript`, draft/queue recovery, model/effort pickers and normal dictation targeting. Add small pane props/slots for the master header and read-only options. Do not fork the whole transcript/composer. The master header holds **Watcher**, the meter, **Stop all** and **More Watcher actions**. Its normal turn Stop remains available through the existing send/stop behavior. Remove native permission widening, working-copy switching, Git/terminal/tool execution and native skill selection from this master variant; workers retain ordinary controls.

Main stores the validated result of each mutating tool call as a receipt/card record, with the current master message/tool-call anchor, operation ID and target. Add a projection hook next to `WorkspaceHost.decorateMessages()` and a renderer `WatcherReceipt.tsx` integrated with `ThreadTranscript`. Extend `ThreadToolResult` with a structured result so adapters and the model get the same receipt. The card is rendered from main's record, not parsed from assistant prose or trusted raw tool HTML. Correlate the provider tool-call ID when available; otherwise use the stable operation ID and current message/turn anchor. Replays produce one card whose delivery state updates.

Cards show what Watcher did: **Started**, **Queued**, **Sent**, **Steered**, **Stop requested**, **Settled**, **Delivery uncertain**, or **Refused**, plus target, source facts and time. A thread card opens beside. **Open to answer** focuses the worker's own request card. No answer buttons or approval controls appear in master cards. Takeover has a Sotto receipt even if the assistant omits it. With history off, cards with message text disappear on restart while text-free delivery/ownership facts remain available as current state.

The meter is **3 of 4 watched**, with a detailed accessible description of reserved/queued/waiting/uncertain targets. Stop all opens the existing confirmation-dialog pattern, naming the eligible started-here targets and explaining the narrower scope. Cancellation changes nothing. Confirmation and eventual results are visible receipts. Reducing the limit below current usage starts no replacements and stops nothing; admission waits for usage to fall.

### A real beside pane

Opening an Overview row or transcript card retains the room, master draft, queued input and reading position. Mount a real `ThreadPane` for that worker, with its own `AgentRequestCard`, command target, draft and message subscriptions. Use the existing `ThreadPanes`, `splitLayout.ts` and `paneGrid.ts` minimum-pane logic, pane focus behavior and divider. V1 has one beside worker; another open replaces that pane without stopping or settling the previous worker. Closing it leaves work intact.

Keep this room's current master/beside selection separate from the remembered Threads page's panes and project. The special master must not become an invisible selected row when the user returns to Threads. Only **Open in Threads** deliberately changes that page's target; tool-created workers never change either room's focus.

At widths that cannot fit two 400-pixel panes plus the divider, use the existing one-pane-at-a-time tabs, **Watcher** and the worker title, as `a2Room()` demonstrates. Both remain open in the state; keyboard activation and returning to the master restore their prior focus/scroll. This is how 820x560 honors beside opening without clipping. Do not use a request overlay or redirect the opening into Threads. **Open in Threads** is a separate worker-header action that explicitly selects the Threads room and target.

Reuse normal pane request routing. Answering a worker's request updates its pending state and Overview through the same user command as Threads. Sending an unrelated direct instruction triggers takeover in main before dispatch, including from this beside pane. Keep actual user-read observation separate from automation subscriptions so opening a visible worker clears Finished unread naturally and a background read does not.

### Visual and keyboard checks

Add one scoped stylesheet, proposed `src/renderer/src/watcher/watcher.css`; add every new stylesheet to `owned` in `tests/unit/renderer/themeTokens.test.ts`. All colors use `--tt-*` roles. Check actual surface/text contrast at 4.5:1, Figtree hierarchy, light/dark, reduced motion, long titles, many threads, empty/disconnected states and minimum size. Header controls must remain operable when the meter wraps; the composer and request actions cannot disappear below the window.

Accessible names include **Open [thread] beside Watcher**, **Open [thread] to answer [question/permission]**, **Open [thread] in Threads**, **Close [thread] pane**, **Resize panes**, **Stop threads started by Watcher**, **More Watcher actions**, and **Watcher message**. Cards use normal buttons/links and semantic status text, without nested buttons. Overview group headings/counts and concise changed-status announcements do not steal focus or read streaming text aloud. Controls in drag regions opt out of dragging.

The keyboard path follows the eye: sidebar switch/list, master header, transcript/card actions, composer; then the beside header, request cards, transcript and composer. Existing pane-navigation controls handle moving between panes. Escape closes menus, confirmations or the beside pane at the appropriate level and returns focus to the opener; it never cancels a native turn merely to dismiss a view. Use A2 as the reference for implementation, and the prototype skill for any new unresolved UI choice. This planning-only work creates no additional prototype.

## 7. Remote hosts and phone clients

### Desktop master to a paired host

The current `DesktopHostRouter` in `src/main/hosts/desktopHostRouter.ts` already routes `command()` and thread/file/Git reads. `src/shared/clientIdentity.ts` qualifies host entity keys, and `LocalHostService` in `src/main/agents/hostService.ts` delegates to `AgentControl.commandShell()`. Starting, sending, queuing, steering and stopping remote threads can use those paths, with explicit host/Sotto targets and no selection change. Never route by the UI's selected host; remote project IDs belong to that host.

It is not enough to forward a command as a privileged desktop client. Add a named optional host feature, `watcher-control`, with a closed request envelope and machine origin, admitted only for the paired desktop. The owning host validates request/operation identities, default permission ceilings, pending requests and takeovers, persists text-free ownership/receipts, and rechecks immediately before its provider writer. The desktop holds the global four-slot budget; the host holds operation/ownership fences and cannot mint extra global capacity. Disconnect leaves an admitted operation uncertain/occupying a slot. Host restart does not turn it into a new send.

Add `watcher-reads` for bounded positional thread reads and evidence/participation deltas. The desktop currently reads remote shell/details, not the event stream; do not pretend a detail revision is an event sequence or message position. The feature supplies host-side cursors/epochs and source evidence while preserving existing shell/detail subscriptions. Native or phone input on the host publishes a takeover before the next machine dispatch. If this end-to-end path is missing, the desktop offers read-only existing summaries but refuses automated remote mutations, including start. No fallback to an ordinary privileged command.

Extend `src/shared/hostProtocol.ts`, `src/host/remoteCommands.ts`, `src/host/index.ts`, `hostService.ts` and the router with optional fields/named operations as documented by `docs/host-protocol.md`. Protocol stays v1; older hosts omit features and receive no new operation. The feature does not confer remote-answer policy or allow answer/permission commands. Deny forged origins from phone/general socket clients. Restrict server credentials to the master session and paired connection; do not expose its local bearer token on the wire. A desktop master reads host thread evidence and project metadata through this feature; no native file mount or project-file broker is added.

### iPhone and Android

Recommendation: hide the special current/retired master from ordinary phone thread lists in v1; keep every ordinary worker visible on its owning host, with the existing request-card answers and direct-send takeover behavior. A phone connected to this computer sees this computer's workers, not the desktop router's combined remote roster. A phone connected directly to a paired host sees that host's workers. Do not imply the desktop's aggregate is a host-v1 phone feature. Master visibility is Zach's choice in section 12.

Use optional `kind`/participation fields and named feature negotiation. Unknown optional fields remain harmless to old clients. If old phones must also hide the special master, filter it from phone shell/detail/event projections and deny master-targeted phone read/select/send commands instead of relying on a decoder they do not have; desktop IPC and admitted read tools still see it. The full desktop room and its third switch do not become phone UI.

Phone source boundaries are `apps/ios/Sources/SottoCore/Threads.swift`, `FocusThreads.swift` and `NewThreads.swift`, plus `apps/ios/Sotto/AppModel.swift`/`HostConnection.swift`; Android uses `apps/android/app/src/main/kotlin/com/millzach/sotto/core/{Wire,Threads,NewThreads,Commands}.kt`, `app/AppModel.kt` and `ui/ThreadsScreen.kt`. Keep the existing phone **Needs you** meaning unless a separate phone change is approved; desktop Overview failures do not silently redefine it. Worker answers continue through host authority, and ordinary direct sends notify takeover.

## 8. Settings

Add only `watcherInFlightLimit`, integer 1..8, default four, to the type/schema/default/parser in `src/shared/settings.ts` and the settings patch allow-list in `src/main/ipc/registerIpc.ts`. Add its schema/save tests, especially `tests/integration/ipc.test.ts`. Read the effective limit in main for every admission, not from the model or a renderer counter. A lower limit holds new starts/sends until usage falls; it stops nothing.

Provider, model and effort belong to the current master record/ordinary thread options and existing native account settings. They need no duplicate global preference. The prompt cap is initially the fixed constant described above, not another setting. There is no Watcher enabled/voice toggle, key, coordinator reasoning selector, permission preference or auto-answer option. The user-facing **Threads in flight** control can live in the room's More actions/settings entry, reusing `SettingsView.tsx`/existing field components; do not scatter separate controls across pages. Its IPC mutation saves the real setting and returns the effective limit.

## 9. Decisions and documentation

Watcher contract is [ADR-0071](../adr/0070-Watcher-coordinates-threads-with-its-providers-own-tools.md), following ADR-0068. Record the single current master, native-plan billing, pinned asking mode and native reads, main-owned bounded start/send authority, human-only answers, takeover, event wake-ups, scoped Stop all, privacy storage and host feature enforcement. Explicitly amend the authority described by ADR-0004/0005 for Watcher start/send without resurrecting automatic supervision; preserve their human-only answers. Relate ADR-0002 identity, ADR-0016 history, ADR-0035 special threads, ADR-0061 wake-ups and any provider-change exception/policy. If no supported launch can enforce a provider profile, record refusal rather than changing the decision to permissive mode.

Update `CONTEXT.md` using `docs/agents/domain.md` and the domain-modeling vocabulary:

- **Watcher:** the one current native agent thread on a computer using its provider's own tools/settings and Sotto's bounded thread tools, with pinned asking permissions, with its own room. Do not call it the old Coordinator, an assignment or an Agents room.
- **Overview:** the room's sidebar list of all other threads, grouped by what the user must do, with source/read times. This word does not currently name a thread queue; it is a projection, not a work/attention store.
- **Watcher request:** a particular user instruction to the master, with main's identity and budgets. Qualify it to distinguish it from an agent's pending question or permission request.
- **Thread card:** a main-backed reference/receipt in the master's transcript opening a real thread pane; distinct from a request card and from a visual.
- Amend **Takeover** after the removal: direct user instruction/control relinquishes Watcher participation; opening/reading and answering an existing request card do not. There is no assignment to switch to manual mode.
- Extend **Thread pane**, **Room**, **Switch**, **Wake-up** and **Read before a send** where their current wording assumes Threads-only panes, two rooms or babysitting-only news. Keep Sequence number, message position, detail revision, Command receipt and delivery receipt distinct.
- Define **Quiet** as observed active work without progress for the stated threshold if it needs a glossary entry; it is neither Idle nor native Background work. Landing is a UI group over observed approval/merge state, not permission authority.

`README.md` explains the third room, native provider/account choice, visibility of actions, master with pinned asking permissions, worker questions and takeover. Its Privacy and cost section says registered project files and bounded worker history may be sent to the chosen master provider when used; remote-host summaries are included when requested. No new external service/key is introduced. Recheck every actual contacted host against that section; any additional host requires its own ADR/README decision before implementation.

`docs/guide.md` covers Overview groups/read freshness, beside opening and Open in Threads, request-card answering, limits/uncertainty, Stop all confirmation, provider compatibility/change and phone scope. `docs/agent-control.md` explains the closed tools, main request/ownership records, lanes/outbox/recovery, refusal and wake-up paths. `docs/host-protocol.md` documents optional fields and both named features. Update `docs/ci.md` only if the actual gates change.

Write a future verification note under `docs/verification/` with a small intentional `artifacts/watcher/` set: A2 desktop widths/themes, request answering beside, takeover, bounded receipts, remote disconnect and actual native tools and pinned-mode proof. Add generated artifact ignores to `.gitignore` and `eslint.config.mjs` as required. Do not commit every intermediate capture. This plan creates none of those future files and claims no running-app evidence.

## 10. Tests and running-app proof

All commands below are implementation done-checks, not commands run while writing this plan. Use deterministic fake-provider barriers for races and lost acknowledgements, not shortened deadlines or real sleeps. Fakes verify Sotto's wiring; live native proof verifies reads without cards, interrupted edit cards and the native permission boundary.

### Unit and integration files

| Test files to add or extend | Required coverage |
| --- | --- |
| Proposed `tests/unit/shared/watcher.test.ts`, `watcherOverview.test.ts` | Strict input/output and refusal schemas; no answer/permission escape fields; bounded cursors; grouping precedence/freshness; defaults and non-comparable permission refusals. |
| Proposed `tests/unit/main/watcher.test.ts`, `watcherTools.test.ts` | Single-master creation recovery/token admission; unique retry/digest identities; start+first-send partial failures; capacity/prompt reservations; permission-widening refusal and native request-card routing. |
| Extend `tests/unit/main/agentCommandLanes.test.ts`, `agentControlRecovery.test.ts`, `agentPersistence.test.ts` | Tool sends share normal lanes/outbox/receipts and do not move selection; lost acknowledgement reconciles without replay; existing user queues survive takeover/Stop all; restart with uncertain capacity; strict old-state migration and current-kind conflicts. |
| Extend `tests/unit/main/wakeUpQueue.test.ts`, `babysitting.test.ts`; proposed `watcherWakeUp.test.ts`, `watcherEvidence.test.ts` | Clock-driven two-second batch/max delay, quiet deadline once per episode, latest truth folding, answered/retired/stopped/taken-over stale news pruned at both dispatch checks; unchanged babysitting behavior; failed/stale evidence and shared-worktree attribution. |
| Extend `tests/unit/renderer/themeTokens.test.ts`; proposed `watcherReceipts.test.tsx` and `watcherView.test.tsx` | Every stylesheet owned; main-backed cards update without duplicate actions; pane/tab/draft focus behavior, keyboard room switch and safe accessible labels, using the existing TSX renderer harness. |
| Proposed `tests/integration/watcherTools.test.ts`, `watcherRecovery.test.ts`, `watcherProfiles.test.ts` | Real child-process fake providers; all launch/new/load/turn/configuration paths keep the profile; exact tool preallowance; worker permissions remain user-only; key replay after process loss; permission-widening rejection and allowed model/effort changes; native direct-user takeover vs tool-origin message identity. |
| Extend `tests/integration/adapterContract.ts` and provider fixture drivers | Common profile capabilities/refusals and unchanged ordinary contracts. Script typeInProvider, pending question/permission, delayed ack, foreground completion/failure, background work and restart. Devin refuses hosting but remains a start/send worker. |
| Extend `tests/integration/ipc.test.ts`, `socketHost.test.ts`; proposed `watcherHosts.test.ts` | Settings allow-list; private origin cannot be forged over generic IPC/socket commands; host-v1 optional fields/feature absence; host-owned limits/permissions/takeover; explicit routing/no navigation changes; remote positional thread reads; offline/reconnect uncertainty. |
| Extend `apps/ios/Tests/SottoCoreTests/{ProtocolTests,PhoneTests,NewThreadsTests,FocusThreadsTests}.swift` and relevant AppModel tests; `apps/android/app/src/test/kotlin/com/millzach/sotto/core/{ProtocolTests,PhoneTests,NewThreadsTests,FocusThreadsTests}.kt` | Optional kind/participation compatibility, master visibility policy, unchanged worker cards/phone Needs you, and direct phone input fences later master sends. |

The brief calls out `tests/integration/fixtures/`; this checkout's actual fake programs are under `tests/fixtures/`: `fakeCodexAppServer.mjs`, `fakeClaudeThread.mjs`, `fakeGrokThreadAgent.mjs` and `fakeDevinAgent.mjs`, with integration helpers beside `adapterContract.ts`. Extend those; do not move them or create a duplicate fixtures tree.

History-off tests inspect Sotto-owned JSON, SQLite presence/content, queues, draft snapshots, temporary files, corrupt backups and captured logs for distinctive prompt/file/error strings. They must verify privacy after restart and toggling history, not only assert that one table is empty. With history on, card anchors, rewind, forget and retention must leave valid operation receipts without reviving sends. Native provider session files are outside Sotto's Keep local history promise and are tested/documented separately.

### E2E and captures

Add `tests/e2e/watcher.spec.ts`: first entry/native choice, request submission, worker start/send card, Overview, opening beside, actual question/permission answer, return to the master, direct takeover, pending-send refusal, Stop all cancel/confirm/partial results, capacity/prompt exhaustion, provider unsupported/change, restart and history off. Extend `tests/e2e/thread-workspace.spec.ts`, `thread-sidebar-question.spec.ts`, `thread-sidebar-resize.spec.ts`, `settings-index.spec.ts` and `new-thread-settings.spec.ts` where the shared components change; keep three-room keyboard coverage in the new Watcher spec.

Seed representative data in `src/main/e2e/agentEffects.ts` without creating production authority shortcuts. Extend `tests/e2e/design-capture.spec.ts`, `scripts/design-capture-matrix.mjs` and the existing capture/verify scripts with empty, normal, Needs you, beside and narrow-tab A2 views. Check 1600x1000, 1280x800, 820x560; light/dark/reduced motion; keyboard focus, long titles, many rows, disconnected host and wrapped header. Compare the rendered app against approved A2. Regenerate baselines only for intentional changes, and say so in the PR.

Before any implementation PR is called green, run the documented gates exactly: `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=2`, `npm run notices:verify`. Then `npm run build` and the relevant `npx playwright test tests/e2e/<spec>` invocations, followed by `npm run design:verify` once intentional baselines are reviewed. Do not run multiple built-Electron suites against the same runtime directory concurrently. Use the two-axis code-review skill for Standards against AGENTS and Spec against this brief; fix material findings before readiness.

Use one opt-in suite gated by SOTTO_WATCHER_LIVE=1 plus a provider selector, never in CI. Per provider, use at most four turns on a fresh disposable project: call a stand-in sotto_threads tool with no card; native read/search with no card; native edit raises a normal card, interrupt without answering and check the sentinel unchanged; cold resume and call the tool again with no card. Probe Codex's Windows read-only sandbox with an unasked native write without another model turn. Stop on an unblocked write; report setup failures as unproved. Check free memory before live runs and wait below 3 GiB. Save only check results in a gitignored folder, and cite curated evidence in the own-tools Windows note. macOS remains separately unproved; there is no admitted-version/platform list.

Where phone code changes, run the macOS iOS compile/XCTest gate and the Android checks from `apps/android`: `./gradlew :app:testDebugUnitTest :app:assembleDebug`. Drive actual request answering/direct-send takeover through the available simulator/device path. Record what was verified on each surface; do not call Windows proof a macOS/phone pass.

## 11. Tickets in dependency order

Each ticket is one coherent PR-sized slice with its own tests and relevant docs. Builder names are future staffing labels: **Sol** for main/IPC/tool work and **Opus 5.5** for user-facing UI. No builders or implementation runs are started by this plan. Shared file ownership is serialized; stable interfaces allow separate UI and main work without competing edits.

### Ticket 0 — Remove voice control and per-thread Manage

- Goal: land the whole removal plan and ADR-0068, preserving manual threads, dictation, memory boundaries and babysitting.
- Builder/ownership: the removal's own Sol and Opus 5.5 slices; owns every file named by that plan.
- Depends on: none; all Watcher integration waits for its final retained interfaces.
- Done-check: removal's CI/e2e/native-phone/design proof and two-axis review, with no live old authority remaining.

### Ticket 1 — Record Watcher and its closed contract

- Goal: establish ADR-0071, shared request/tool/receipt types, one-current-master identity, text-free control records, settings limit and migrations.
- Builder: Sol. Owns new `src/shared/watcher.ts`, `watcherOverview.ts`, Watcher record/store module, plus schema-only edits to `agents.ts`, `settings.ts`, `workspace.ts`, `control.ts`, `registerIpc.ts`; ADR and initial CONTEXT/host-protocol contract wording.
- Depends on: 0; record Zach's choices that affect continuity/phone projection before those consumers land.
- Done-check: unit schema/grouping/store/migration/privacy tests, `tests/integration/ipc.test.ts` setting save, documented gates. Publish fixtures/interfaces for UI; do not advertise provider support yet.

### Ticket 2 — Run the master on its provider's own tools

- Goal: retain native provider tools/settings with pinned asking modes, a shared guidance prompt and exact Sotto preallowance on every lifecycle path.
- Builder: Sol. Owns `host.ts`, `threads.ts`, `codex.ts`, `claude.ts`, `grok.ts`, their launch/environment helpers and profile capability tests/fake-provider changes. Small startup/profile wiring in `workspace.ts` follows ticket 1's schema edits; no renderer ownership.
- Depends on: 1.
- Done-check: profile/adapter integration suites and ordinary adapter regressions, then the bounded own-tools Windows live suite and separate macOS proof. Record failures and unproved surfaces plainly; Devin retains its tested refusal. Gates must pass; a fake-only pass is not profile completion.

### Ticket 3 — Serve local tools through the existing command paths

- Goal: create/recover the master and expose local roster/read/start/send/queue/steer/stop/settle with native project reads, with app-enforced budgets and takeover.
- Builder: Sol. Owns `watcher.ts`, `watcherTools.ts`, `threadToolServer.ts`, `control.ts`, `followups.ts`, `workspace.ts`, `threadStore.ts`, private IPC/preload additions and `src/main/index.ts` integration. Owns local tool/recovery tests and receipt/card projection.
- Depends on: 1 and 2; do not overlap ticket 2's workspace launch edits. Keep adapters stable after profile handoff.
- Done-check: Watcher unit/integration suites, lost-ack and pending-request/takeover races, history-off disk inspection and no-selection-change proof, then gates. A local native conversation can use tools without a new account and cannot answer or widen a worker request.

### Ticket 4 — Wake from events and attach observed evidence

- Goal: batch participant changes through the existing wake-up queue and publish sourced PR/checkpoint/Git/failure evidence.
- Builder: Sol. Owns new Watcher wake/evidence modules, `wakeUp.ts`, `babysitting.ts`, `githubBabysitReads.ts`, `checkpointIntegration.ts`/checkpoint evidence additions, plus sequential integrations in `control.ts`, `followups.ts` and `workspace.ts`; corresponding tests.
- Depends on: 3. It follows ticket 3 where they share delivery/store files; the established receipt/evidence contract lets UI work proceed independently.
- Done-check: deterministic batching/quiet/stale-news tests, unchanged babysitting integration, evidence attribution/privacy tests, fake/native finish/question/failure wake proof, then gates. No Watcher poll timer exists.

### Ticket 5 — Enforce the same origin on paired hosts

- Goal: add optional host-v1 control/read features with owning-host enforcement, explicit routing and positional thread reads.
- Builder: Sol. Owns `desktopHostRouter.ts`, `hostService.ts`, `src/host/index.ts`, `remoteCommands.ts`, `hostProtocol.ts`, host feature/client identity helpers and remote integration suites/docs. Adapter/control changes must consume the established local enforcement service, not fork it; coordinate any needed shared edits after ticket 4.
- Depends on: 3 for commands and identity; 4 for complete event/evidence delivery. Protocol preparation/tests can proceed after 3 without enabling remote automation.
- Done-check: socket/remote feature/refusal/reconnect/takeover tests, paired-host real start/send/read/stop and failure proof, gates and host build check from CI. Old hosts refuse new automation safely.

### Ticket 6 — Add the third room and sidebar Overview

- Goal: build A2's shared foot switch and Overview shell over the shared projection, with the real master pane, limit control and pinned Ask before changes label.
- Builder: Opus 5.5; user-facing UI. Owns `App.tsx`, `AppContext.tsx`, `AppShell.tsx`, `SidebarFrame.tsx`, `PageSidebar.tsx`, new `WatcherView.tsx`/`WatcherOverview.tsx`/`watcher.css`, narrowly scoped `ThreadPane` header/options props and renderer theme/keyboard tests. Sol tickets own main/preload contracts.
- Depends on: 1's types for mock-backed development and 3's IPC for a complete PR. May run alongside 4 and 5 with no shared file edits.
- Done-check: build plus Watcher first-entry/Overview/three-room keyboard e2e, rendered A2 at three sizes/themes/reduced motion, settings save, theme-token ownership and gates. No dead Manage/voice control or Threads-page redirect.

### Ticket 7 — Show receipts and answer in the beside pane

- Goal: finish main-backed transcript cards, real beside opening/narrow tabs, normal native request cards for the master, worker request answering, takeover feedback, meter and confirmed Stop all.
- Builder: Opus 5.5; user-facing UI. Owns `WatcherReceipt.tsx`, Watcher view/style updates, `ThreadTranscript.tsx`, `ThreadPane.tsx`/`ThreadComposer.tsx`/`PaneMenu.tsx` integration, `ThreadPanes`/split helpers only where reuse needs it, Watcher e2e and deliberate design captures.
- Depends on: 3's receipts/stop/takeover, 4's news/evidence and 6's shell. May run alongside 5; keep all main/store changes with Sol. It follows 6 where renderer files overlap.
- Done-check: actual worker question/permission answered in its own card beside the master; preserved drafts/read positions; direct user takeover blocks queued sends; Stop all affects only eligible started-here threads; 820x560 tabs and keyboard/Escape focus; gates plus design verification.

### Ticket 8 — Preserve phone lists and phone-origin takeover

- Goal: implement the chosen master visibility projection without changing ordinary phone worker journeys or host-v1 compatibility.
- Builder: Sol for host projection/core wire behavior; any changed phone UI is an Opus 5.5-owned sub-slice handed off after the wire PR. Owns phone socket shell filtering, iOS SottoCore/AppModel and Android core/AppModel consumers/tests; no desktop renderer edits. Keep host projection edits after ticket 5's shared host files.
- Depends on: Zach's visibility choice, 3's kind/takeover service and 5's final host protocol. Workers remain visible before this ticket; do not expose the master accidentally to old phones.
- Done-check: old/new v1 decoder tests, iOS compile/XCTest, Android unit/assemble, real phone/simulator answer and ordinary-send takeover proof, desktop/host regressions. Any user-facing phone list change receives its own prototype/clarification before UI implementation.

### Ticket 9 — Prove and document the complete Watcher

- Goal: close integration gaps, document the final behavior and record complete running/native tools and pinned-mode evidence before release readiness.
- Builder: Opus 5.5 owns final A2 comparison/design/accessibility proof; Sol owns main/host/provider gaps and CI. This ticket owns final README/guide/agent-control/CONTEXT/ADR updates, verification note and small artifacts, capture matrix/baseline review and integrated e2e fixes. It does not become a catch-all feature expansion.
- Depends on: 2–8 and resolved product choices.
- Done-check: exact CI gates, affected Playwright and design verification, Standards/Spec reviews, installed Windows/macOS native tools, interrupted edit cards, cold resume, room and remote proof and touched phone gates. Fix discovered material issues in the responsible coherent follow-up PR. Report actual native results and inherited-permission limitations; Windows proof does not prove macOS.

The useful parallel lane is tickets 4/5 (Sol main/host) beside ticket 6, then ticket 7 (Opus 5.5 UI), after the ticket 1/3 contracts settle. Tickets sharing `control.ts`, `workspace.ts`, host schemas or renderer pane files do not run competing edits. The labels describe requested builders; they do not imply that Opus 5.5 is installed or that a run has been authorized by this planning turn.

## 12. Risks and choices only Zach can settle

Decided by Zach on 2026-10-08: both recommendations below. Watcher itself is hidden on phones in v1, while its workers stay visible; and changing its provider starts a replacement native conversation, keeps the previous one as Watcher history, and offers a visible bounded handover. ADR-0071 records both. The original framing is kept for the reasoning:

1. **Phone access to the master.** Recommendation: hide current/retired masters on the phone for v1, while ordinary workers remain fully usable on their host. Alternatively, show the current master as a typed ordinary thread, clearly saying it can direct threads on other paired computers even though the phone does not show that combined roster. This choice determines socket projection and phone list work; it does not grant authority to answer workers.
2. **Changing the master's provider.** Recommendation: start a replacement native conversation, preserve the previous one as Watcher history, and offer a visible bounded handover. This fits the current immutable thread binding. Alternatively, require the same visible transcript/Sotto identity across providers; that needs a deliberately versioned binding/history design and an ADR-0002 amendment, rather than weakening `ThreadRegistry.reserve()`. Choose before provider-change UI and migration land.

Other unspecified values have concrete reversible recommendations in this plan: four total prompts per thread per request, a two-second batching window with five-second maximum delay, a 20-minute quiet threshold, and a single beside worker pane. No decision reopens the approved A2 shape, typed interaction, user-only answers, master with pinned asking permissions, native account choice or Stop all scope.

## Handoff

Path: `docs/plans/2026-10-08-command-center.md`.

1. Voice removal and ADR-0068 land before any Watcher work.
2. One current native master thread is recovered by Sotto identity and kind.
3. It uses Claude Code, Codex or Grok Build on the user's own plan.
4. Native provider tools/settings remain; pinned asking modes refuse widening and ordinary edit cards reach the user.
5. Code reads/searches are native; Sotto exposes only scoped thread and operation reads.
6. Closed thread tools use existing lanes, outbox and delivery receipts.
7. Questions and permissions stay on each worker's own request card.
8. Main records requests, ownership, budgets, delivery and takeovers without logged text.
9. Four threads in flight and four prompts per thread/request are enforced by the app.
10. Batched event wake-ups carry sourced evidence without Watcher polling.
11. A2 gains the third foot state, sidebar Overview and real beside panes/narrow tabs.
12. Optional host-v1 features enforce remote authority and preserve phone workers.
13. Tests, native asking-mode proof, design checks and docs are assigned to ten tickets.

Ticket 0 — Remove voice control and per-thread Manage; land ADR-0068 first.
Ticket 1 — Record identity, closed contracts, limits and privacy-aware migrations (Sol).
Ticket 2 — Run and prove Watcher on native provider tools with pinned asking permissions (Sol).
Ticket 3 — Serve local tools through existing commands and safe project reads (Sol).
Ticket 4 — Batch wake-ups and attach observed evidence (Sol).
Ticket 5 — Enforce optional Watcher control/reads on paired hosts (Sol).
Ticket 6 — Add the third room and sidebar Overview (Opus 5.5 UI).
Ticket 7 — Show receipts and answer in the real beside pane (Opus 5.5 UI).
Ticket 8 — Preserve phone visibility and phone-origin takeover (Sol; Opus 5.5 for any UI).
Ticket 9 — Complete docs, native/room/host proof and final review (Opus 5.5 UI; Sol main).

Open questions: hide the master on phones initially (recommended), or expose its typed thread; replace the native master on provider change with visible handover (recommended), or require cross-provider identity/transcript continuity. No npm, build, test or commit was run for this plan.
