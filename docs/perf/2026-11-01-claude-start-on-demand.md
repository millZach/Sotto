# Claude Code starts on demand - November 1, 2026

Part of #992, the item "Viewing a Claude thread starts a Claude Code process". Counted with
`tests/integration/claudeStartOnDemand.test.ts` over the fake Claude CLI, and over the same stack with origin/main's
sources (`f976052cc`) for the before column. The memory each CLI holds is read from real Claude Code processes.

```sh
NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/integration/claudeStartOnDemand.test.ts --maxWorkers=2
```

## What it cost

Putting a Claude thread on screen started its Claude Code CLI: the coordinator observes every pane, the active thread
and a draft, and the adapter started a CLI for each thread it observed (`observeThreads`). The session reaper never
stopped a CLI in the watched set, so each stayed as long as its pane was open, idle or not.

A Claude Code CLI is not small. On forge on October 31, 2026, ps read 104 to 308 MB resident per CLI; the ten Sotto
thread CLIs running there that evening read 84 to 275 MB, 1.74 GB together. #992 measured 270 to 295 MB of working set
each on Windows. So browsing ten saved threads held ten CLIs: 1 to 3 GB on forge, about 2.8 GB on Windows, before a single
message was sent.

## The change

Zach's call, approved in the round's plan: Claude Code starts when you start typing, send, or Watcher watches the thread
(ADR-0016 and ADR-0038, November 1, 2026 amendments).

- A thread on screen is read from its transcript, as before (`messageLog.observe`, the catch-up read as it comes into
  view, the poll each second of threads in use), and starts no CLI.
- Its CLI starts on any command for it, on a read before acting on it, and when the user types, pastes or dictates into
  its composer (ADR-0057's early start).
- The coordinator names the **live-session set** to its host (`keepSessionsLive`) just before each observation: Watcher's
  watched threads, delegations, queued follow-ups of the user's, outbox entries and a send's own thread. The workspace,
  the provider switch and the Sotto thread host pass it on as they pass the observation. Claude Code's adapter starts a
  CLI for each thread in it, starts only these at connect and after a client update, and its reaper spares only these.
- An idle CLI behind a pane alone is stopped after thirty minutes like any other idle session. A busy one is never
  stopped.
- Other providers do not take the set and are unchanged. A Claude adapter that is never told a live-session set keeps
  the old rule.

## Before and after

Fake CLI, forge. "Before" ran the first test's observation (ten saved threads put on screen through the whole stack:
coordinator, workspace, provider switch, Sotto thread host and adapter) against origin/main's sources at `f976052cc`,
where it fails reporting the adapter's start asked ten times. The other rows count what this branch's tests run.

| | Before | After |
| --- | ---: | ---: |
| Starts the adapter is asked for when ten saved threads come on screen (measured) | 10 | 0 |
| CLIs started at connect with ten threads on screen, two kept live (after measured; before by the old rule, one per observed thread) | 10 | 2 |
| A pane typed into once, idle past the reaper's window (150 ms in the test), beside one kept live: CLIs left (after measured; before by ADR-0038's old rule, which spared every observed thread) | 2 | 1 |
| Resident memory of the CLIs behind ten panes (estimate: the counts above times 104-308 MB per CLI from ps on forge) | 1.0-3.1 GB | 0 |

The memory row is an estimate. No run here browsed ten threads with the real Claude Code and read resident memory before
and after: each count comes from the fake CLI, and each real CLI's size from ps. On forge, October 31, 2026, the ten
Sotto thread CLIs running that evening read 84-275 MB each, 1.74 GB together, and #992 measured 270-295 MB on Windows.

## Open to first words

What this change costs is a send to a thread opened and sent to without typing: the CLI now starts inside that send.
Claude Code takes 1.0-1.5 s to start (2.1.289, `docs/perf/2026-10-06-early-start.md`, measured with the real client), so
that send's first words come that much later than when opening the thread had started it. A send after typing costs
nothing more: typing starts the CLI (ADR-0057), and the send finds it running. The fake CLI starts in milliseconds, so the
tests here count starts rather than time them; the cost is the real client's start, measured in October.

- Typing in the composer starts the CLI (`startOnTyping` in `src/renderer/src/agents/earlyStart.ts`, called from the
  prompt editor's change in `ThreadComposer.tsx`).
- Pasting does too: the prompt editor handles a paste as an edit, and its change starts the CLI.
- Dictation does too, since Sotto's dictation pastes into the focused composer through the system. It does so only when
  the words land, after the speech is transcribed, so a send pressed straight after a dictation still waits for most of
  the start.
- A next prompt taken with Tab, and words that Screenshot to message adds, are written into the draft from outside the
  editor and start nothing early; a send right after either pays the start.

A thread in the live-session set pays nothing: its CLI is already running, as before.

## The guard

`tests/integration/claudeStartOnDemand.test.ts`, in the default suite:

- through the whole stack, observing ten saved threads asks the adapter for no start and starts no CLI; a message
  Claude Code writes into one of their transcripts afterwards reaches the adapter's events by its own reading, with
  nothing asking for a snapshot; two of them becoming a delegation's starts two; typing in a third starts a third; the
  delegation ending starts and stops nothing;
- connecting with ten threads on screen and two kept live starts exactly two;
- a send to a thread on screen starts that thread's CLI and no other;
- with a 150 ms idle window, the reaper stops an idle CLI behind a pane and never the one kept live, and the stopped
  thread keeps its messages and starts nothing while it stays on screen;
- an adapter that is never told a live-session set still starts every observed thread, as before;
- open to first words: after typing started a thread's CLI, a send to it starts none of its own, and a send to a thread
  only on screen starts its CLI.

`wakeUpQueue.test.ts` checks a delivered follow-up lets its thread leave the live-session set, so an idle CLI there is
the reaper's again; without the refresh the coordinator now makes when its queue or outbox changes, it stays.

Against origin/main's sources the first fails with the start asked ten times, and the next three fail because the
adapter has no live-session set. `claudeClientUpdate.test.ts` checks that a client update starts a thread kept live
again on the new client straight away and leaves a thread only on screen stopped until it is sent to.
`threadNavigationDelivery.test.ts` and `wakeUpQueue.test.ts` check the coordinator keeps no session live for a pane,
does for a send's own thread and a queued follow-up, and `sottoThreads.test.ts` and `workspaceStoredActivity.test.ts`
check the layers pass the set on.

## What it leaves

- A thread still starts its CLI on a read made before acting on it, such as a review or Watcher reading it.
- A composer restored with skills chosen asks for the skills catalog, which Claude Code lists in a short process of its
  own with no session; it exits once it has (ADR-0016).
- Claude Code's question about compacting an old session it resumes, and its hooks and MCP servers, now come when the
  user types or sends, not when the thread is opened.
- Codex, Grok Build and Devin still start a process for every thread on screen. #992 tracks Devin's idle replays
  separately; whether the others should take the live-session set is not decided.
