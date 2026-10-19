# Answering in Watcher's conversation, October 19, 2026

When a watched thread asked a question or a permission, the user had to open that thread to answer it. On the morning of October 19, four threads waited at once, each needing its own trip. Zach picked variant B of the answering prototype that day: the thread's own card, inline in Watcher's conversation under the reply that told of it. [ADR-0073](../adr/0073-watcher-coordinates-threads-with-its-providers-own-tools.md#october-19-2026-answering-in-watchers-conversation) records the picks and the decisions behind them.

## What changed

- **The card.** Under the reply in which Watcher tells the user about a waiting request: the thread's name, its provider and computer, question or permission, **Open**, the thread's last reply folded under **Show what it said**, then the same request card the thread's pane shows. The answer is the user's own, sent to that thread with the ordinary `answer` command, never through Watcher.
- **The answered line.** Once the request leaves the thread, answered anywhere or withdrawn, one line takes the card's place with **Open**: "You answered Fix login: Use the staging key." when this window sent the answer, never repeating the user's own words, otherwise "Fix login no longer waits on you."
- **The needs-you line** goes to the card in the conversation and focuses it, and opens the thread beside Watcher as before when the conversation holds none.
- **The record.** A Watcher wake-up keeps the requests its news said waited on the user, as identities alone, with the wake-up (`wake_ups.watcher_asks`, migration 8, and `wakeUpAsks` in `workspace.json`). The room places each card from that record (`asks`), never from anyone's words.

## How it was checked

On Windows, in this thread's worktree, against Sotto Owl built from the branch. Full suites were left to CI at Zach's request; locally, typecheck, lint and the files below.

**Against main's own Watcher, nothing seeded** (`tests/e2e/watcher-answer.spec.ts`, over the fake Codex app server):

- A thread on this computer under a standing watch asks a question. Main's own wake-up reaches Watcher, Watcher replies, and the card appears under that reply, placed by main's `asks` on the reply's own message ID; the wake-up, which held only news, is shown nowhere. With the thread open beside Watcher, its own pane shows the same question. Choosing Blue on the card in Watcher's conversation sends the answer: the fake Codex receives `{ choice: { answers: ['Blue'] } }` for the thread's request, the question leaves the thread's pane at the same moment, the needs-you line empties, and the line reads "You answered Pick the badge colour: Blue." [The card](../../artifacts/watcher-answer/answer-main-card-dark-1280x800.png), [the line](../../artifacts/watcher-answer/answer-main-line-dark-1280x800.png).
- A thread on a paired host, through the real headless host, socket and desktop router (the unpackaged harness bypasses SSH only), asks a question. Watcher on this computer replies, the card shows the host's name, Forge, and choosing Coast reaches the provider on that host as the user's answer for its own request. [The card](../../artifacts/watcher-answer/answer-forge-card-dark-1280x800.png), [the line](../../artifacts/watcher-answer/answer-forge-line-dark-1280x800.png). The stand-in host files its thread under Codex with a Claude test model, so every surface, this card included, shows the Codex mark beside the word Claude; a real host's thread agrees with itself.
- Making this journey possible, the unpackaged paired-host harness now builds its socket with the same Watcher answer `DesktopHosts` passes (`src/main/e2e/remoteHost.ts`); before, no end-to-end journey could put Watcher on a paired host.

**On a seeded room** (`tests/e2e/watcher.spec.ts`, all 24 journeys pass): a permission card, in dark and light with reduced motion, at 1600x1000, 1280x800 and 820x560, with nothing outside the window and every text at or above 4.5:1 ([readings](../../artifacts/watcher-answer/readings.json)). The needs-you name focuses the card without opening the thread; Tab reaches Open and then Show what it said; Escape folds the reply back onto its toggle; Allow leaves the line naming the choice. [The card at the minimum size, light](../../artifacts/watcher-answer/answer-card-light-820x560.png), [the line, light](../../artifacts/watcher-answer/answer-line-light-1600x1000.png).

**Unit and integration** (each run on its own):

- `tests/unit/renderer/watcherAsks.test.tsx`: the card under the right reply with its last reply folded; the answer goes to the watched thread, never Watcher; the line names the choice even when the request leaves before main replies; only "no longer waits" for an answer given elsewhere; a paired host's permission answered through its own row; one card for a request two wake-ups named; nothing outside Watcher's pane; the needs-you line goes to the card or opens the thread; a title's own full stop is not repeated.
- `tests/unit/main/watcherAskPlacements.test.ts`: placement under the wake-up turn's reply, the message before it, or nowhere; the asks a wake-up carries; Watcher has no tool that answers, and its news still says only the user answers.
- `tests/unit/main/threadStore.test.ts`, `threadStoreVisuals.test.ts`, `workspaceWakeUps.test.ts`: the asks are kept text-free through a messages-reset, a reopen and a restart with Keep local history on or off, and an older database migrates without losing a wake-up.
- `tests/integration/watcherTools.test.ts`: a wake-up records the request its news names and the room places its card, without Watcher answering it.
- Unchanged and passing: the copy-site list and the streaming copy budget, the theme-token check, and the existing Watcher, wake-up and paired-host suites that touch this code (`remote-question-receipt.spec.ts`, `remote-activity-body.spec.ts`).

## Not checked

- An installed Owl build against a live Watcher on a provider account, and a thread on the real forge. The journeys above run main's real Watcher, wake-up, workspace record, socket and router with stand-in providers; nothing here installs the branch over the running Sotto.
- macOS and Linux. Nothing in this change is platform-specific.
