# Watcher's request note, October 14, 2026

On October 13 Zach's own message in Watcher's room ended with a long line Sotto had added, `[Sotto Watcher request: …]`, naming the request, the local host and every known project ID. Main appended it to the user's text in `WatcherService.beforeDispatch`, so it went to the provider as part of his words, came back in the provider's echo and history, and was drawn in his bubble. The phone projection took it off only for messages it could tie to a request. [ADR-0073](../adr/0073-watcher-coordinates-threads-with-its-providers-own-tools.md#october-14-2026-the-request-note) records what replaces it.

## What changed

- A user Send to Watcher goes to the provider as typed. Main puts a **Watcher request note** on the send instead (`watcherRequestNote` on the host command): the request ID, the local host ID and one sentence. It lists no projects; Watcher's launch instructions tell it to call list_projects.
- Codex gets the note as the turn's `additionalContext`, kind `application`, under `sotto_watcher_request`. Claude Code's Watcher CLI registers a UserPromptSubmit hook at `initialize`, and the adapter answers the hook for the prompt the note was written with, and only that one, with the note as `additionalContext`; any other prompt's hook, a wake-up's or one of Claude Code's own, gets nothing. Grok Build has no per-prompt channel, so its prompt carries the note as one bracketed line after the words.
- The coordinator's snapshot shows Watcher's user messages as typed: it removes only Sotto's exact line, the old project-listing footer or Grok's request line, from user messages in Watcher's own threads. The pane, Copy and the phone all read that snapshot. Assistant words and every other thread are untouched, and the provider's own history keeps what it was sent.

## How it was checked

On Windows, in `.worktrees/watcher-tag`:

- `tests/integration/watcherTools.test.ts`: the provider receives the user's words alone, with no tag and no project ID, and the note names the request and host; that request ID still starts a worker through `start_thread`; a later instruction carries its own request's note; a worker's prompt carries none. An older message with the footer shows as typed in the thread detail, while an assistant reply quoting the footer and a user's own lookalike text stay as they are. These and the phone test below fail on the code before this change.
- `tests/integration/watcherPhone.test.ts`: a phone instruction reaches the provider as typed with its note beside it, and an older footed message reads as typed in the phone projection and over the socket.
- `tests/integration/watcherOwnTools.test.ts`, against Sotto's fake providers: Codex's `turn/start` carries the note in `additionalContext` and its input is the typed text; Claude Code's Watcher CLI alone registers the hook, its prompts are the typed text, and the hook gets each prompt's own note once, never a wake-up's or a prompt of Claude Code's own that reaches the hook first; Grok's prompt ends with exactly the request line, and an ordinary thread gets neither.
- `tests/unit/main/watcherRequestNote.test.ts`: only Sotto's exact lines come off, and only from Watcher's own user messages.
- `npx playwright test tests/e2e/watcher.spec.ts`, against main's own Watcher on the fake Codex app server: the bubble shows "Check the release notes and tell me what is missing." and nothing else, and the app server's `turn/start` carries that text as its input and the note, with no project, as application context. [Capture](../../artifacts/watcher-request-note/room-main-sotto-dark-1280x800.png); the [October 11 capture](../../artifacts/watcher-room/room-main-sotto-dark-1280x800.png) shows the line it replaces.

Gates, on the final commit: `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=2` (819 files, 10,399 tests passed, 321 skipped), `npm run notices:verify`, `npm run build`, `npm run test:socket` (490 passed, 10 skipped) and `npx playwright test tests/e2e/watcher-gate.spec.ts tests/e2e/watcher.spec.ts` (17 passed). An earlier `test:socket` run, before the review fixes, lost one `launchScriptBoot.test.ts` case while another worktree's suite ran on the same machine; that file passed alone and in every run since.

## Not checked

- No live provider turn. The three channels come from codex-cli 0.162.1's generated schema, Claude Code 2.1.299 and its Agent SDK, and the Codex, Claude Code and Grok Build sources; the opt-in `SOTTO_WATCHER_LIVE=1` suite was not run. If the note does not reach a live Watcher, its sotto_threads changes are refused as naming no active request, and nothing is sent.
- Grok Build's own terminal, opened on Watcher's session outside Sotto, would show the request line after each message.
- The iPhone app was not run; it draws the projection the phone test reads.
