# Phase 1 backend integration contracts

Backend contracts for the pending Phase 1 renderer implementation. These describe implemented local backend behavior; they do not mark the tickets complete.

Integration amendments: provider latency measures only host execution, excluding image-cache persistence and failure cleanup. Privacy changes attempt all independent stores and retry incomplete cleanup through the existing maintenance timer. Workspace cache recovery creates no raw-content backups and removes only its generated stale temporary/corrupt copies. See the accompanying implementation verification record for regression evidence.

# Phase 1 #44 backend contract — proposed v1 (2026-09-12)

Backend owner: Codex. Baseline 7e3809f (includes 52f1f42). No renderer edits.

## Shared API (existing window.sotto.agents bridge)

`AgentState.threadDrafts?: AgentThreadDraft[]` (backend always supplies an array):
`{ threadId: string; draftId: UUID; text: string; attachments: AgentAttachment[]; requestId: string | null; updatedAt: string }`.
One draft per Sotto thread ID. No provider/session IDs. The legacy `draft`, `draftThreadId`, `draftRequestId`, `draftAttachments`, `composing` remain the managed/voice composer surface. Legacy bound drafts migrate into threadDrafts under the SAME owner/request; unbound retired-provider recovery stays unbound and uses existing recover-draft.

New command: `{ type: 'save-thread-draft', threadId, draftId, text, attachments?, requestId? }`. Omitted attachments means []; omitted requestId means null. Generate a fresh UUID on every content revision (including image edits), keep it stable when sending/retrying that revision. This saves immediately outside the provider command lane, with no selection or management side effect. Empty text + [] clears that thread's entry. Await the command promise to know persistence completed; errors remain in returned state.error. Flush edits before navigation/unmount; send captures its exact text/images/id so it also persists without depending on an earlier debounce. Never save an older debounce after sending; cancel pending debounce on submit. Managed/voice controls may keep using compose/send.

Existing command unchanged: `{ type: 'manual-send', threadId, draftId, text, attachments? }`. Supply draftId for durable idempotency. Promise still completes after provider outcome, but `onState` emits local delivery progress immediately: do not await it to render local feedback. No running-turn editable queue in #44; running/managed/disconnected checks remain enforced. Manual sends do not create assignments. Use existing managed controls for managed threads.

`AgentState.deliveries?: AgentDelivery[]` (backend always supplies an array):
`{ threadId: string; draftId: UUID; status: 'queued' | 'submitting' | 'accepted' | 'failed' | 'uncertain'; createdAt: string; updatedAt: string; commandId?: string; messageId?: string; localFeedbackMs?: number; providerLatencyMs?: number }`.

- queued = locally received, awaiting the existing command lane/validation; NOT the #51 running-turn queue and NOT provider acceptance.
- submitting = durable outbox intent recorded before invoking provider.
- accepted = exact user message ID observed in bound provider state (never inferred from a resolved IPC promise or matching text).
- failed = no provider commitment / explicit rejection; draft retained for explicit retry.
- uncertain = dispatch may have committed; draft retained, no automatic resend. Existing refresh/reconnect or repeating manual-send only reconciles the original action. Same draftId cannot be dispatched twice after acceptance.
- terminal delivery metadata is bounded; unresolved delivery metadata survives restart. No prompt/image content in delivery records. localFeedbackMs measures command receipt to first backend state publication; providerLatencyMs measures host execution separately. Windows renderer paint measurement remains UI/integrator responsibility.

Read a thread's composer from `threadDrafts.find(d => d.threadId === thread.id)`; read relevant delivery by threadId + draftId, or latest record for the thread. On acceptance, clear only the submitted revision, never newer text/images. Existing `deliveredDrafts` exact receipts remain compatible. Do not clear on submitting/uncertain or on a generic command resolution. Show unsaved/storage failures from state.error.

## Change log
- v1: initial contract published before implementation. Any implementation changes will be recorded here.

## Implementation notes — v1 finalized

- Implemented the v1 shapes exactly; no preload change is needed because the existing bridge uses the shared command/state schemas.
- `save-thread-draft` does not set the global busy flag. It persists even while unrelated provider work is blocked. Repeated saves must be ordered by the renderer; cancel obsolete debounce work. The main process keeps the command-arrival order. Do not infer edit order from delayed command responses; keep locally dirty text until the corresponding revision is acknowledged.
- Saves using an already accepted draftId are ignored (prevents a stale post-send debounce resurrecting it). Editing a queued/submitting/uncertain revision requires a fresh draftId. A saved question answer cannot silently become a manual prompt: clear it explicitly first, or preserve requestId while editing.
- Disconnected native drafts may be edited. Send still validates connection, membership, model attachments, pending requests, running status and manual/managed authority. Existing global-busy manual-send rejection remains in place; queued describes brief command intake only. #51 is not implemented.
- Managed/voice compose and clear synchronize the per-thread entry. Their existing ownership is retained across navigation; use their existing `compose`/`send` controls. The manual path publishes queued before provider reads. Managed/supervised sends gain submitting/uncertain/accepted records at dispatch, but do not get the manual intake timing metric.
- On restart, a queued record with no outbox becomes failed (interrupted before dispatch). A submitting/outbox record becomes uncertain. Neither is automatically submitted. Legacy native singleton and outbox records acquire UUID draft revisions without changing the Sotto thread ID or question request. Retired-provider unbound recovery behavior is unchanged.
- Successful delivery removes only the matching revision and exact text/image digest. Identical replacement edits with a NEW UUID remain. Accepted and failed records are bounded to the latest 128; unresolved records are retained. Existing accepted-receipt retention is also 128. Idempotent replay suppression is guaranteed for retained receipt identities and all unresolved outbox actions, not an unlimited historical receipt archive.
- Delivery records contain metadata only, no text/images/error text. Unsent drafts are intentional working state and persist with history disabled, matching the pre-existing privacy policy. Sent content leaves the draft state on exact acknowledgement. Existing assignment/turn privacy rules remain.

## Measured backend fixture (Windows, 2026-09-12)

`tests/unit/main/threadDrafts.test.ts`, one worker, full selected regression run: 0.2287 ms command invocation to first queued subscriber callback; backend localFeedbackMs 0.0938 ms; providerLatencyMs 46 ms with a deliberately held provider call. These are synthetic local measurements, not native provider performance or renderer paint. Parent/UI must measure keydown-to-visible-frame separately on the agreed visible Windows fixture; target remains <100 ms.

## Renderer acceptance checks still owned by UI/parent

1. Restore threadDrafts by Sotto thread ID; preserve attachments/requestId. Keep legacy recovered/managed controls intact.
2. Generate a fresh UUID per edit; save complete text/images; cancel stale debounce at submit and flush before navigation/unmount. Keep in-flight image processing scoped to its source draft; disable send until attachment bytes are ready.
3. Send a captured immutable revision via manual-send. Listen to onState immediately. Render queued/submitting/accepted/failed/uncertain distinctly and clear only an accepted matching revision. Do not equate the command promise resolving with delivery.
4. Offer Refresh/reconnect for uncertain delivery, never automatic resend. Explicit retry remains safe while unresolved and after a retained acceptance receipt.
5. Verify Enter/Shift+Enter, IME and skill-menu guards, disconnected/managed threads, navigation/restart with text/images, and local paint timing. No running-turn editable queue or steer implementation belongs to this slice.

- Final compatibility check: the existing explicit `answer` command also clears a matching per-thread question draft after success; it preserves an answer edited to a new UUID while submission is in flight. Answer controls continue to use existing request reconciliation; the new `deliveries` list describes prompt sends, not permission/answer decisions.

# Ticket #45 backend/shared contract

Revision 1 — 2026-09-12. Proposed implementation contract; UI can implement against these names now.

Existing `window.sotto.agents.command(...)`, `get()`, and `onState(...)` bridge remain the transport. All commands return AgentState, including errors in `state.error`.

Commands:
- `{ type: 'settle-thread', threadId: string }`
- `{ type: 'restore-thread', threadId: string }`
- `{ type: 'settle-project', projectId: string }`
- `{ type: 'restore-project', projectId: string }`
- Existing create-project/select-project/create-thread/select-thread commands retain their signatures. Use `useExisting: true` to open an existing directory. Multiple threads may share one project.
- Existing `{ type: 'configure-thread', threadId, modelId?, reasoningEffort?, runtimeMode? }` selects a provider by its scoped ready model ID. No separate provider-switch command.

State additions (optional for backward compatibility; production workspace host supplies them):
- `state.host.projects[].workspaceSettledAt: string | null`
- `state.host.threads[].workspaceSettledAt: string | null` — INDIVIDUAL choice, not inherited from project.
- `state.host.threads[].nativeSessionStarted: boolean` — false only for a Sotto-owned local empty thread. Missing means conservatively locked, just like true.
- Shared helper `isWorkspaceThreadSettled(thread, project?)`: own workspaceSettledAt OR owning project's workspaceSettledAt. Existing provider lifecycle settledAt/archivedAt remains separate.

A settled project moves as one folder/group. Restoring the project only clears the project's workspaceSettledAt; prior individually settled threads stay settled. Restoring a thread only clears its own choice, so a settled parent still contains it. Neither command deletes history, interrupts native work, changes assignments or removes attention. Keep working/attention indicators visible in Settled. Settlement works while disconnected and survives restart.

New empty threads are durable local records until first send. `nativeSessionStarted === false` allows any ready model/provider; use that model's advertised reasoning/runtime options. Once native creation is dispatched (including uncertain creation), provider choice locks. Existing discovered/native threads are locked even if their visible transcript is empty. Same-provider changes continue to require native configureThread capabilities and advertised model options. Provider choices never change coordinator configuration.

Project/thread IDs remain opaque. Existing projects retain their IDs and memory scopes; new cross-provider threads stay under the originally selected project ID. No path-based merge of existing project scopes. Disconnected history remains in host.projects/threads; connection status still determines whether native actions are possible. Keep search over these retained rows.

Ownership: backend edits shared/main and tests only; no renderer/CSS/draft implementation. Parent will integrate shared/control overlaps with #44. Follow-up revisions and implementation caveats will be recorded below.

## Revision 2 — implemented contract and recovery details

Public command/field names in Revision 1 are unchanged. Implementation is `WorkspaceHost`, wrapped around the existing ConfiguredProviderHost -> SottoThreadHost -> native adapters in main/index.ts (also around the E2E host).

- `workspace.json` stores the retained catalog/history, individual/project settlement, local thread creation intent, and aliases for provider project registrations introduced by a new cross-provider thread. Existing project scopes are never merged. Automatically introduced registrations do not appear as duplicate empty project folders.
- `nativeSessionStarted` is a conservative provider-lock flag: native creation dispatch/reserved identity locks it, including uncertainty. A definitive failure before binding unlocks it; a definitive rejection with a reserved binding permits retrying the first prompt on that same provider. An uncertain creation is only observed, never recreated.
- A late native creation confirmation does not send the user's prompt automatically. The prompt was not dispatched; the user retries it explicitly. Existing native prompt uncertainty remains in AgentControl's outbox unchanged.
- On restart every provider is disconnected and every cached model is not ready until native discovery confirms it. Thread status in a disconnected row is last-known status, not proof that the native process is still running.
- The existing Keep local history setting is honored: transcript/request bodies are excluded from the workspace file when off. Identity, settlement and creation recovery metadata remain. A provider reconnect can rehydrate native history.
- New empty/local thread settings are app-side choices; renderer should allow configure controls even when the old provider is disconnected or does not advertise configureThread, as long as the chosen model/provider is ready and can create threads. Native/unknown threads still require their original provider's configureThread capability.
- `create-project` with `useExisting: true` reopens an already-known folder for that provider using the original project ID. The selected project's settled state is unchanged by opening it; use restore-project explicitly.
- No preload implementation change is necessary: its existing strict shared-schema parsing passes the new commands and fields. A focused preload test verifies reply/event round-trips and malformed payload rejection.

Acceptance checklist: [x] early contract; [x] backend organization; [x] disconnected persistence and original scopes; [x] local/native provider boundary; [x] focused unit/controller/preload/native transport tests; [ ] final validation and local commit; [ ] result handoff. Renderer wiring and rendered review belong to the separate UI worktree.

## Revision 3 — final verification

Implementation acceptance checklist: [x] early shared contract; [x] durable organization/scopes/history; [x] provider-boundary and recovery tests; [x] preload contract tests; [x] final typecheck and focused ESLint; [x] production build; [x] existing Electron thread-creation journey (including configuration and image prompts). The targeted regression run passed 172 tests with 2 pre-existing fake-fixture skips. Native child-process fixture verification is synthetic; no paid/live provider turn was run.

Inspected the Electron screenshot generated by the existing journey. It shows the current baseline renderer only; the new project-group/settlement controls and provider-unlock UI still require Fable's wiring and rendered review. Evidence was moved within this worktree to test-results/projects-verification/.

Local commit complete: 97af9fabb5a43fa9a6c2bf6af4913d162e7221fd. Result handoff: projects-result.md. Final checklist: [x] validation; [x] local commit; [x] result handoff. An additional native late-prompt acknowledgement test passed after the 172-test regression batch (workspaceNative rerun: 2 passed).

# Phase 1 #46 attachment backend contract — proposed v1

Baseline: 7e3809f. Ownership: src/shared/agents.ts, small src/main/agents/control.ts hooks, new src/main/agents/attachmentPreviews.ts, shared raster validation helper if needed, focused tests. No renderer edits, native transport changes, dependencies, or new IPC.

## Exact state addition

Existing AgentMessage.attachments[] remains { id, name, mimeType, sizeBytes } with optional `preview: { dataUrl: string }`. dataUrl is restricted to validated, bounded base64 PNG/JPEG/GIF/WebP raster data. Renderer may use preview.dataUrl as an image source; its absence means metadata-only/unavailable. Never interpret attachment names, IDs, MIME strings or message markup as file access instructions. Existing name/MIME/byte-size metadata already covers supported attachment details; native file/link attachment ingestion is not currently supported and this slice will not invent it. Ordinary links remain message content for #46 UI.

## Persistence and identity

New app-owned AtomicJsonStore `attachment-previews.json`: `{ version: 1, entries: [{ threadId, messageId, commandId, storedAt: number, attachments: AgentAttachment[] }] }`. Only validated user-submitted images enter this store, immediately before host execution after capability validation. Exact Sotto thread + user message identity attaches the preview when native history confirms that message. A conflicting commandId never matches. Uncertain sends keep the bytes for later reconciliation; definitive rejections remove them. No provider session IDs, synthesized messages, resend path, filesystem paths, or markup-triggered reads.

History enabled: seven-day expiry from original submission, bounded to 100 MiB decoded image content by oldest-entry eviction. History disabled: no submitted-image bytes persisted; current-process previews may remain for new sends, but switching history off clears prior previews and the store. Unsent drafts keep the existing explicit draft exception. Corrupt cache is discarded without content backups. The store is the single owner of preview bytes.

## Sibling integration

#44 owns threadDrafts/deliveries and draft lifecycle. This implementation only hooks the common dispatch path; no draft schema or delivery mutation is needed. Parent will combine the small control.ts hooks with #44 edits.

#45 owns WorkspaceHost history/cache. Previews are added only to cloned outbound AgentControl.get()/onState state, AFTER WorkspaceHost, and never injected into host snapshots/caches. WorkspaceHost retains ordinary message metadata; after disconnected/restart history is loaded, the same IDs recover previews from the preview store. Do not feed the decorated control state back into workspace persistence. No workspace.ts or index.ts ownership overlap is expected.

## Checks / current status

- [x] Read domain docs, approved discussion, ticket, relevant ADRs, sibling contracts.
- [x] Verify baseline and pinned T3 d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3; its Normalizer.ts claims/persists submitted attachments independently of message markup.
- [x] Implement safe state/schema + durable store + dispatch hooks.
- [x] Test persistence, exact identity, uncertainty/rejection, privacy/expiry, unsafe payloads and provider limits.
- [x] Typecheck, focused regression tests, local commit, final result report.

Any final differences will be recorded here.

## Final implementation revision — 2026-09-12

Contract fields and ownership above are implemented unchanged. `agentAttachmentPreviewSchema` validates the bounded raster data URL, reusing the same MIME/signature rules as native submission through `hasRasterImageSignature`; it is not a full image decoder/transcoder. Unsupported/executable formats, MIME/signature mismatches, paths and remote URLs are rejected. No raw provider preview field is trusted: decoration strips it before matching locally submitted user images.

The preview store also removes only its own generated AtomicJsonStore crash-temporary filenames on initialization. Malformed cache entries are dropped individually; malformed top-level JSON is replaced without a corrupt-content backup. Maintenance runs at startup, on privacy changes, and on the existing 30-second control timer. History-off submissions can have in-process previews but are never retrospectively persisted when history is enabled later. Failed redaction remains dirty for a later maintenance retry; outbound state hides prior retained previews immediately.

Shared delta is limited to optional `AgentAttachmentReference.preview` and exported raster validation; AgentState, commands, draft schemas, provider capabilities, native transport and IPC signatures are unchanged. Native Claude's metadata-only origin registry is intentionally unchanged. Codex and Grok still advertise `supportsImages: false`.

Integration checklist for parent:
- Merge the small AgentControl constructor/start/get/privacyChanged/dispatchPending/timer hooks alongside #44's changes. `get()` must clone internal state before decoration. Retain both agents' dispatch error handling.
- #45's WorkspaceHost remains upstream of AgentControl and must persist its own undecorated native snapshots. No preview bytes belong in WorkspaceHost cache. Retained messages with the same Sotto thread/message IDs receive previews from this store even when disconnected.
- UI consumes `message.attachments[i].preview?.dataUrl`; omitted previews retain metadata-only behavior. Supported native file/link attachment ingestion did not exist in baseline; no new file/link command or URL fetching path was added.
- Expired/evicted/pre-change images cannot be reconstructed from filenames or native transcript paths. Native metadata remains readable. Capacity is 100 MiB decoded content (base64 JSON is larger); no thumbnail transcoding or lazy image IPC was introduced.

Checklist complete for this owned backend slice: implementation, focused safety/privacy/identity and fake-native restart tests, typecheck, lint, local commit, result report. UI implementation and Windows rendered verification remain parent/UI-owner work; this slice does not claim whole-ticket completion.
