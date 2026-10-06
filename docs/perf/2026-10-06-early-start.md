# Early start: the first send without its CLI's start - October 6, 2026

Issue #769, part of #762. A new thread's first send created the thread with its provider and started the thread's
client inside the send, and for Claude Code that is a CLI that spawns and answers `initialize` before the prompt can
be written to it. An early start (ADR-0055) does that when the user starts typing, so the send finds the client
running. At connect, Claude Code's adapter also started the watched threads' CLIs one after another, so a send to the
last of them waited for the others; it now starts them four at a time. This note measures both, against the installed
Claude Code and against the fake CLI.

The issue's references still pointed at the right code, moved: the watched-set start on observe is
`claude.ts:466-474` (`observeThreads`), the workspace's refusal to observe a thread with no native session is
`workspace.ts:2287`, and the sequential connect loop was `claude.ts:350-354`.

## Against Claude Code 2.1.289

`tests/integration/claudeEarlyStartLive.test.ts` (`SOTTO_CLAUDE_LIVE=1`) drives the adapter over the installed,
signed-in client in a temporary synthetic project. No prompt is sent and no model turn runs, so it times the part of a
first send that starts the client: the provider's `create-thread`, which the workspace runs inside the first send
before the prompt goes out. "Before" is a thread created with nothing started for it, which is what every first send
did before this change, since nothing asked for an early start. "After" is a thread created after an early start for
it had finished. Five rounds of each, one run.

| | Median | Range |
| --- | ---: | ---: |
| Creation, before (starts the CLI) | 1,180 ms | 1,043-1,519 ms |
| Creation, after (adopts the spare) | 5.3 ms | 4.8-185 ms |
| The early start itself, while the user types | 1,129 ms | 1,030-1,272 ms |

All five spares were adopted by their thread's creation. Claude Code wrote no session file for any of the ten threads
or for a spare that was let go without a send, checked across every folder under `~/.claude/projects`. A bare probe of
the same client before any of this, spawning it with Sotto's arguments and timing the `initialize` answer, gave
939-1,058 ms; the CLI said only its hook frames and the answer, and wrote no session file before or after it exited.

At connect, with four watched threads whose CLIs had to start, three rounds of each:

| Watched CLIs started | Connect |
| --- | ---: |
| One after another (before) | 6,275 / 7,130 / 8,225 ms |
| Four at a time (after) | 3,685 / 3,672 / 3,956 ms |

Four CLIs starting together each take longer than one alone, so the gain is less than four times, but a send to the
last thread no longer waits for the three before it.

## Against the fake CLI, the whole first send

`tests/perf/earlyStart.perf.test.ts` sends a new thread's first prompt through the workspace, the Sotto thread host
and the adapter over `tests/fixtures/fakeClaudeThread.mjs`, timed until the send is accepted. Nine sends in each mode
per run, three runs; the ranges are the run medians.

| First send | Median across runs |
| --- | ---: |
| Nothing started first (before) | 252-291 ms |
| After an early start that had finished | 184-191 ms |
| Send pressed 150 ms after the first key | 171-194 ms |
| The early start itself | 71-95 ms |

The fake starts in about 80 ms, a fraction of the real client's second, so the gap here is the fake's start and the
real one is the table above. What is left of the first send, about 185 ms on the fake, is the rest of Sotto's work
before the prompt goes out: the working-copy check, the creation's saves and the read before the send, which #765,
#766 and #767 take on.

## What these numbers are not

- They are not the time to the model's first words. No prompt was sent to the real client; the issue accepts no live
  model turn. The saving is the start a first send no longer pays, and it applies only when the user typed for at
  least as long as the start takes, about a second. A send pressed sooner waits for the rest of the start in the
  thread's lane, which is never longer than starting inside the send.
- The early start counts only for a new thread in the shared project folder, or a thread whose session is stopped. A
  thread on screen already had its session from opening it, and a new worktree thread gets nothing before its send.
- The real client's figures include the user's own hooks on the development machine; other machines' hooks and MCP
  servers add to both columns alike.
- Taken on the Windows development machine (Intel Core Ultra 9 275HX, Node v24.14.1) while another agent's build and
  tests ran on it. Read them as sizes, not budgets. Nothing asserts a time.

## Re-run

```sh
SOTTO_CLAUDE_LIVE=1 npx vitest run tests/integration/claudeEarlyStartLive.test.ts --maxWorkers=1 --disable-console-intercept
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/earlyStart.perf.test.ts --maxWorkers=1 --disable-console-intercept
```
