# Thread history on the event store, checked in the running app

September 19, 2026. The built app (`npm run build`, `out/main/index.js`) was launched by a Playwright driver in the e2e boundary (`SOTTO_E2E=1`, scenario `success`, the fixture providers) on a scratch profile holding a copy of the owner's real `workspace.json`: seven threads, 156 messages, 4.6 MB. The live profile was not touched. Screenshots are in `artifacts/event-store-hand-test/`.

## Migration

On first start every message left `workspace.json` for `threads.sqlite`: 156 `message-added` events, one `messages-reset` per migrated thread, and the same per-thread counts in the `messages` projection as in the file. After the rewrite `workspace.json` was 22 KB and held organization only. A reading taken a second after launch still showed the old size, because the rewrite lands on the write window rather than at once.

## History window

The thread with the most turns (eleven user messages, 31 messages) opened on 28 messages, ten turns, with `earlierAvailable` true and **Show earlier messages** above the oldest (`thread-opens-on-newest-window.png`). One press from the keyboard (focus, Enter) loaded the remaining three, drew the oldest message, and the control went away (`show-earlier-messages-after-press.png`). The first run of this journey needed two presses: the pane retained its first rendered row when the window widened, so the loaded rows sat behind its own paging control. The store control now lets that row go, and the recheck shows one press.

## Attribution

A permission raised on the fixture thread and answered through the window's command bridge left one `answer-given` event: `requestId`, `approved: true`, and `attribution { clientId: "desktop-window", user, transport: "ipc" }`, with no answer text.

## Keep local history off

With the setting off before launch and the thread pane open, a message typed into the provider appeared in the pane at once (`history-off-message-in-app-only.png`) and the phrase was absent from `threads.sqlite`, its write-ahead log and its shared-memory file after the app closed. With the pane closed the same message is not in any window, which is the watched set doing its job rather than the setting. The first run left an earlier run's text in the file when the setting had been turned off while Sotto was not running; the store now redacts the file before opening in memory, and a unit test covers it. Turning the setting back on kept the next message and the secret phrase stayed absent.

## Not checked here

Lazy provider sessions need real providers; the fixture host has no per-thread sessions to start or stop. The adapter contract covers this with the fake Claude, Codex and Grok child processes: connect starts no per-thread session, entering the watched set or the first command starts one, an idle one is stopped and resumes with the same messages, and a running turn or a watched thread is never stopped.
