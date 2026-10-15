# Watcher wakes for what needs it, and its wake-ups are not messages

Checked on Windows from branch `fix/watcher-wake-noise`, after Zach watched four
threads on October 14, 2026 and found Watcher woken by almost every tool call in
them, each wake-up shown as a "Sotto · Wake-up" bubble of machine text. ADR-0073's
two October 14 sections record what changed.

## What wakes Watcher

Before, a worker's working-copy and Git evidence changing during its turn was
"changed evidence" news with a wake-up of its own, and every receipt of
Watcher's own sends woke it. Now Watcher wakes when a watched thread's turn
finishes or fails, a question or permission card appears, a thread goes quiet,
or a pull request's link, state, checks, review or merge state changes. A
thread's own evidence rides with its next turn end, and only when it differs
from what Watcher was last told. A receipt wakes Watcher only when the send
failed, was refused or may not have gone.

`tests/unit/main/watcherWakeUp.test.ts` drives the real wake-up batcher with a
fake clock: many evidence changes during one running turn deliver nothing until
the turn ends, then one wake-up carrying them; an accepted receipt delivers
nothing, a failed or uncertain one does; finished, question, failed, quiet and
pull request news still wake it. Those cases fail on the parent commit.

## How the wake-up travels

A wake-up's Watcher news is now the send's `watcherNews`, given to the model
the way the request note is: Codex `turn/start` `additionalContext` under
`sotto_watcher_news`, the Claude Code UserPromptSubmit hook, or Grok Build's one
bracketed line. The message itself is a short line of Sotto's. The coordinator
leaves a wake-up of only Watcher's news out of the queue it publishes, and
leaves recorded wake-ups out of Watcher's presented conversation, which the
pane, Copy and the phone read, and out of a Watcher row's summary. Provenance
decides: a message the host recorded as Sotto's wake-up, never one the user
typed, whatever it says. An earlier build's saved wake-ups are hidden the same
way; a resume note or pull request news in one keeps its own words.

`tests/integration/watcherOwnTools.test.ts` checks each fake provider receives
the news in its channel and an ordinary thread receives none.
`tests/integration/watcherTools.test.ts` checks the queue panel, the
conversation, the phone projection and the row summary show no wake-up text,
that old saved wake-ups are hidden, that a user's identical message is kept,
and that a paused wake-up no one can see goes on by itself after Watcher's next
turn. `tests/unit/main/followupWakeTypes.test.ts` covers that recovery in the
queue store.

## Gates

From source `fe5d35753`, on Windows: `npm run typecheck` and `npm run lint`
passed; `npm test -- --maxWorkers=2` passed 853 files and 11,008 tests (74
files and 345 tests skipped) in 29 minutes; `npm run notices:verify` verified
189 components; `npm run build` passed; `npm run test:socket` passed 23 files
and 497 tests; `npx playwright test tests/e2e/watcher.spec.ts
tests/e2e/watcher-gate.spec.ts` passed all 22 journeys in 2.0 minutes.

## After merging main's work-settled news

Main then brought work-settled news (#1050). It wakes Watcher, since it is the
second half of a busy turn's end, and what a finished turn's background work
changes rides with it instead of waiting for the next turn. Two new cases in
`tests/unit/main/watcherWakeUp.test.ts` check this. The first fails without the
fold. Both also check that the busy finish's words and the work-settled words
travel in the background note.

From merge `adc208b06`: typecheck, lint, notices:verify, build, test:socket
(23 files, 497 tests) and the 22 Watcher journeys passed. The full suite passed
863 files and 11,276 tests, with one failure: `fences native input arriving at
a prepared paired queue writer before another turn starts` in
`tests/integration/watcherPairedHosts.test.ts`, new on main in #1053. Rerun
alone, it fails the same way. It also failed three runs out of three on main's
own source, even with a fifteen-second deadline. The owning host's failed
receipt either never reaches the master's paired listener or is never
recorded, so the master's receipt stays `dispatching`. This branch does not
cause it, and it is not fixed here.

No live provider, remote machine or installed release was used, and no look
changed: the pane shows Watcher's reply where the bubble was.
