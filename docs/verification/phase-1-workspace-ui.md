# Phase 1 workspace UI verification (#44 drafts and delivery, #45 projects and settlement)

Status: complete on `work/phase1-workspace-ui` (base 0598d48). Implemented by Opus 5 as the authorized fallback while Fable was unavailable.

Commits: b27b3e7 (cherry-pick of parent bf5388b), 2acf2ff, 01e384c, 15d5350, e3ec9ae.

## What changed

- **Per-thread drafts (#44).** `ThreadDraftStore` keeps one draft per Sotto thread, including text, screenshots and the question it answers.
  - Every edit is a new revision with a fresh UUID. Saves are debounced (250 ms) and run in order.
  - Drafts are flushed when you change threads, on `pagehide`/`beforeunload` and on unmount. The exact revision is saved before it is sent.
  - A published state replaces local text only after that state has shown the local revision. Seeing a revision is tracked separately from a successful save: a published draft plus `state.error` shows "Draft not saved. Save again", and retrying saves the same revision.
- **Composer.**
  - Enter sends and Shift+Enter adds a new line. Nothing is sent during IME composition (`isComposing` or keyCode 229), after another handler has taken the key, or while a menu is open (`aria-expanded="true"`, which is where #63's skill picker will plug in).
  - The pending message renders in the same event as the key press. The composer clears only when its own revision is accepted, so edits made while a send is pending are kept.
  - The textarea stays editable while a provider is disconnected or running. Only archived threads and pending permission requests lock it.
- **Delivery states.** Queued, Sending, Sent, Not sent and Unconfirmed come from `state.deliveries`.
  - Retry appears only while the composer still holds the failed revision.
  - An unconfirmed send offers Check again (`refresh`), or Reconnect when disconnected. It is never re-sent automatically.
  - If the provider history already contains the exact message id, the pending card drops its duplicate text and shows only the delivery state.
  - After a restart, the composer shows the stored status of its restored revision.
- **Project folders (#45).**
  - The sidebar groups threads by Sotto project, with Codex, Claude and Grok marks, working and waiting indicators, and clock or elapsed time.
  - The Projects heading counts folders. Thread counts are labelled as threads.
  - Search matches project and thread names, and attention rows are always listed.
  - Add project opens a folder picker and runs `create-project` with `useExisting` (a known folder simply opens). Each folder has a "New thread in {project}" action that preselects the project.
- **Settling.** Settle and restore work for a thread (`settle-thread`/`restore-thread`) and for a whole project (`settle-project`/`restore-project`). Restoring a project keeps any thread that was settled on its own. Threads closed by the provider show as provider state and are not "restored" by the workspace action.
- **Provider choice.** While `nativeSessionStarted === false`, the model picker lists every ready model from connected, thread-capable providers. After the first send, the thread is locked to its provider.
- **Disconnected providers.** Rows and history stay visible. The header shows "{provider} disconnected" with Reconnect, and the composer explains that the draft is saved. Manual sends never assign a thread to Sotto's management.
- **Transcript.**
  - It follows new messages only while you are at the bottom; otherwise it offers "New messages" or "Jump to latest".
  - "Show earlier messages" keeps the anchor in place, and switching threads lands on the latest message.
  - The message list is memoized, so typing does not repaint history.
  - See the integration notes for the parent's 80-message fix.

## Tastify acceptance checks

Target: the Windows Electron main window, reviewed at 1600×1083 capture size and at the 760 px minimum, at 100, 125 and 150% scale, and with reduced motion.

Concept: the conversation and its composer lead, and the sidebar is the map of project folders. The proving moment: Enter puts your message in the transcript before the next frame, with a truthful delivery state, while the folders show what is running or waiting.

1. **Identity.** The Crossing black room, Bricolage Grotesque, teal activity accent and pill chrome are retained. Provider marks adapt the T3 icon paths (MIT; see the integration notes).
2. **Composition.**
   - The transcript and composer dominate. The sidebar is 288 px on desktop, 244 px at ≤980 px and 224 px at ≤820 px, where row times are hidden.
   - At 760 px the header actions move below the title instead of shrinking the type.
   - E2E checks that `.threads-view`, `.thread-nav`, `.thread-workspace` and `.thread-prompt` have no horizontal overflow at 760 px (100, 125 and 150% scale). It also checks that the send button is in the viewport.
3. **Type, against the Tastify thresholds (body 16–18, controls ≥14, secondary ≥12).** These apply to the new and changed Threads controls and message content:
   - **Body (16 px):** message text and the composer textarea.
   - **Controls (14 px):** row titles, folder toggles, search, header actions, pending-card actions, Show earlier and Jump to latest, and the model, effort and runtime pickers in the composer.
   - **Secondary (12–13 px):** status, time, counts, composer status, delivery detail, message headers and option notes.
   - The E2E test asserts the computed sizes after a restart at 760 px: textarea 16px, row title 14px, row status 12px.
   - One exception: the fallback initial glyph for an unknown provider is a 10 px letter inside an 18 px decorative, `aria-hidden` badge. The provider name is carried in the row's text.
   - Shared chrome outside the Threads page (title bar, bottom navigation) is out of scope.
4. **Colour.**
   - New rules use appearance tokens with the Crossing values as fallback. Status always has a text label: Working, Waiting on you, Not sent, Unconfirmed, Disconnected.
   - Provider marks are measured in Electron against the painted sidebar and the selected row:
     - **Dark:** 9.61–14.54:1.
     - **Light:** 4.18–4.91:1. On light, the badge fills are mixed 50% toward `--tt-text`; this measurement uses the appearance lane's light token values injected into this tree.
     - Results are in `artifacts/phase1-workspace/provider-mark-contrast.json`.
5. **Copy.**
   - Delivery labels are single words.
   - The composer shows one status line at a time, in this priority: save error, answer state, restored delivery state, block reason, then the hint.
   - The provider lock note reads "This conversation stays with {provider}." when other providers exist, and "Any provider until your first message." before the first send when more than one provider is available.
6. **Motion.** The folder chevron rotates and the working dot pulses. The pulse only runs under `prefers-reduced-motion: no-preference`, and both are removed under reduced motion and `data-reduced-motion='on'`. E2E asserts `animation-name: none` on every row status dot at reduced motion, at 125% and 150%.
7. **Keyboard.**
   - Every sidebar, header, pending-card and composer action is a native button or input. Row and folder actions show on `:focus-within`, and on devices without hover they are always visible.
   - Escape clears search, and the transcript log is focusable (`tabIndex=0`) for keyboard scrolling.
   - Enter, Shift+Enter, IME and open-menu handling are covered by unit tests.
   - A full recorded Tab walk was not captured.
8. **Rendered review.** The captures below were inspected in the Electron window. Defects found during review and fixed in 15d5350:
   - folder icons shrank beside long names;
   - hidden folder actions took width from the name;
   - the composer status wrapped beside the options at desktop width;
   - an unconfirmed prompt that the provider had recorded appeared twice.

## Local acknowledgement timing

Setup: `tests/e2e/workspace-projects.spec.ts` on the deterministic `success` fixture in Windows Electron. It ran 10 sends with Enter, typing each prompt with a 15 ms key delay. A document capture-phase keydown listener records the start, a MutationObserver records the new "Pending message" article, and the next `requestAnimationFrame` marks the painted frame. Full results are in `artifacts/phase1-workspace/local-acknowledgement.json`.

| Measure (last run) | p50 | p95 | max |
|---|---|---|---|
| Enter → pending message in DOM | 3.7 ms | — | 7.0 ms |
| Enter → next frame after it | 5.2 ms | 18.1 ms | 18.1 ms |
| Keystroke → next frame with the new value (130 keys) | 3.1 ms | 9.9 ms | 17.5 ms |

The test asserts: next-frame max <100 ms and typing p95 <100 ms. Earlier runs were in the same range (next-frame max 18.9 and 20.7 ms).

Reported separately by the backend, which is not UI latency:
- `deliveries[].localFeedbackMs` (main-process receipt to queued publish): ≤0.5 ms.
- `providerLatencyMs` (fixture provider dispatch): 1–2 ms.

Real provider latency is not measured here; no paid provider calls were made.

## Tests

- **Unit** (Vitest, maxWorkers=2):
  - `threadDraftStore.test.ts`: 12 tests, including a published draft with a save error followed by an explicit retry, a failed IPC save, newer edits during failed and successful saves, and a flush on unmount or leaving the page.
  - `threadWorkspace.test.tsx`: 19 tests covering Enter/IME/menu, save-before-send, pending edits, Retry and Dismiss, Unconfirmed with Check again or Reconnect, a history-echoed unconfirmed send, navigation and new window, answer drafts, disconnected state, folders and counts, thread and project settlement, add project, new thread here, provider unlock and lock, and scroll anchoring.
  - `threadsView.test.tsx`: 24 tests.
  - Related suites: threadNavigationConnection, newThreadProjectCreation, threadFactsMetadata and agentView. **100 tests passed.**
  - Earlier: modelPicker, screenshotInput, app, appShell, agentQueue, providersSettings and widgetApp passed.
  - Mutation checks: removing the observed-revision guard or the Retry `holdsRevision` check makes tests fail.
- **E2E** (Playwright Electron, workers=1, after `npm run build`). `workspace-projects.spec.ts` (6) plus `thread-workspace.spec.ts` (3): **9 passed**.
  - Local acknowledgement timing.
  - Project flow on an owned profile:
    - open a temp folder as a project and create two threads through "New thread in {project}";
    - `nativeSessionStarted` is false before the first send and true after, with no assignment;
    - settle and restore a thread and the project, keeping each thread's own settlement;
    - text + PNG draft in Docs and a multi-line draft in Workshop, checked in `threadDrafts`;
    - full Electron restart restores both drafts;
    - 760 px recomposition with computed type sizes.
  - Delivery states: an unconfirmed send is not repeated, and Enter on newer text does not send. Newer text is saved as a draft. Disconnecting keeps history, and the recorded prompt appears once.
  - Provider mark contrast in dark and light.
  - Design fixture at 760 px, 125% and 150% scale with reduced motion.
- `npm run typecheck` is clean, and eslint is clean on the changed files. The tsconfigs do not typecheck `tests/`.

## Screenshots (`artifacts/phase1-workspace/`)

- `projects-desktop.png`: two project folders, a new thread after its first send, and the provider options in the composer.
- `settled-thread.png`: a thread settled on its own, under its project in Settled.
- `projects-760.png`: after restart at the 760 px minimum, with the multi-line Workshop draft restored.
- `delivery-unconfirmed.png`: an Unconfirmed card with Check again, and newer text kept in the composer.
- `disconnected.png`: disconnected provider tag, Reconnect, history kept, and the recorded prompt shown once with its state.
- `design-threads-760-125.png`, `design-threads-760-150.png`: design fixture at the minimum width, scaled, with reduced motion.
- `provider-marks-light-probe.png`: provider glyph contrast with injected light tokens. Only the sidebar tokens are injected, so the rest of the page is not a light-theme review.

## Integration notes and remaining gaps

- **Rich messages.** The parent wired `MessageContent`/`AttachmentPreviews` in a1b6008. My 15d5350 changes the same `PendingMessage` body lines. On cherry-pick, resolve it as `{inHistory ? null : <><MessageContent text={submission.text} /><AttachmentPreviews attachments={submission.attachments} /></>}`.
- **80-message boundary.** The parent owns the fix in ba5ba9e (keep the first rendered message id while you are away from the bottom). This branch still slices the last N messages; do not overwrite ba5ba9e with it.
- **Manual sends and AgentContext.** `manual-send` still goes through AgentContext's command lane. Local acknowledgement does not depend on it; draft saves use the immediate lane from bf5388b.
- **T3 attribution.** `ProviderMark.tsx` adapts T3 `apps/web/src/components/Icons.tsx` paths (MIT, © 2026 T3 Tools Inc.). The rich lane owns adding the attribution to generated notices.
- **Single-provider fixture.** The E2E fixture has one provider, so the provider lock and unlock notes are covered only by unit tests.
- **Light theme.** Contrast is verified with injected light token values; the parent's integrated light captures are the real theme review.
- **Add project picker.** The native folder picker is not driven in E2E. The E2E test calls `create-project`, and the picker flow is unit-tested.
- **Doubled composer note.** A disconnected thread that is still running shows both "Available after this turn finishes." (options) and the disconnected reason.

## Parent integration closure

The integration branch includes the rich-message wiring, stable transcript range, exact draft persistence evidence and connection-owned recovery. These supersede the lane-era notes above about queued renderer sends and standalone store ownership. Parent verification covers real light themes, narrower 760px stress renders, keyboard focus, image containment and a shortened composer. The shipped window minimum remains 820px. Final combined measurements, test results and remaining platform boundaries are recorded in [Phase 1 implementation](phase-1-implementation.md).
