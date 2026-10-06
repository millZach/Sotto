# One read before a send - October 5, 2026

Issue #765, part of #762. A send from the Threads page read its thread several times before and after the provider
heard the prompt: the coordinator's read before the send, the adapter's own read at the start of the send, the
adapter's recheck just before the prompt went out, and, when the provider's echo had not yet been published, a whole
reconciliation read after the provider accepted. Claude's adapter built a whole snapshot for each of its own reads
and threw it away, Grok read every watched thread again each time the coordinator said which threads were on screen,
which it does before every send, and each read through the workspace wrote `workspace.json` and published.

The change: the coordinator's read before a send stands for the adapter's own first read while the thread has not
moved since, so a Codex send makes the newest-turn check once; Claude and Grok keep their recheck after their last
await; nothing inside an adapter builds a snapshot it does not read; a read before a send that changed nothing writes
and publishes nothing; and the read after an accepted send asks the workspace for the echo it holds before reading
whole. What it rests on is ADR-0005's amendment "one read before a send". The checkpoint hook's own read before a
send is #764's and is not in either measurement below: it is wired only in the desktop app, not in the headless
host the benchmark runs.

## What was measured

`tests/perf/sendReads.perf.test.ts` runs each of Claude, Codex and Grok's real adapter under the whole host stack, as
a headless host composes it (`tests/fixtures/sendStack.ts`): the coordinator, the workspace, provider selection and
Sotto's thread identities, over the fake client each adapter's contract test uses, as a real child process. Every
other provider is the in-memory end-to-end host. A thread that has had one exchange is on screen, and it is sent nine
prompts from the Threads page, one after another, each after the last one's turn has finished. Each send is timed
from the press to the coordinator's answer and counts:

- **Reads reaching the adapter**: calls of the adapter's own `refreshThread`, which is how the hosts above it read a
  thread. Before this change the adapter's own reads inside a send were calls of it too, and each built a snapshot.
  After it they call `sync`, which builds none, so they are not in this count; the history reads below count them.
- **History reads**: reads of the thread's history from the provider. For Codex, `thread/turns/list` and whole
  `thread/read` requests, before `turn/start` and after it; for Grok, `_x.ai/session/updates` pages, before
  `session/prompt` and after it; for Claude, polls of the transcript file, which Sotto reads in process, counted
  over the whole send.
- **Adapter publishes**, **`workspace.json` writes** and **workspace publishes** the send set going.

The adapters' poll timers are set to ten minutes so that what is counted is what the send itself read. Claude is also
measured with 1,000 earlier exchanges in its transcript, a 200-character prompt and a 1,200-character reply each, all
filler. Each figure is the median of nine sends in a run; time ranges are across runs, and every count was the same
in every run unless a range is given. "Before" is the benchmark's own commit on this branch, which is `origin/main`
(`e8a82a03`) for everything it measures: six runs at no earlier exchanges, three at 1,000. "After" is this change:
four runs.

| | Send, before | Send, after | Reads reaching the adapter | History reads before the prompt | History reads after it |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude | 107-116 ms | 77-87 ms | 4 → 1 | 3 → 2 transcript polls | 1 → 0 |
| Claude, 1,000 earlier exchanges | 121-123 ms | 74-92 ms | 4 → 1 | 3 → 2 transcript polls | 1 → 0 |
| Codex | 109-143 ms | 86-100 ms | 3 → 1 | 2 → 1 newest-turn check | 1 whole read → 0 |
| Grok | 98-131 ms | 87-89 ms | 4-5 → 1 | 4 → 2 | 2-3 → 1 |

The benchmark counts Claude's transcript polls over the whole send, 4 → 2, since the transcript is a file read in
process. The table splits them by where each read sat: before the change the fourth was the reconciliation read
after the provider accepted.

| | Adapter publishes | `workspace.json` writes | Workspace publishes |
| --- | ---: | ---: | ---: |
| Claude | 4 → 3 | 2 → 0 | 4 → 2 |
| Codex | 4 → 4 | 2 → 0-1 | 5 → 1-2 |
| Grok | 7-8 → 5 | 1-2 → 0 | 5 → 2-3 |

Codex's write is 0 or 1 across runs, and its median was 1 in a later run of the head of this branch. It is not traced
to a cause here. A read before or after a send that changed nothing writes nothing (`readsAroundSend.test.ts`), so
it is either the workspace's write window, set going by what Codex publishes as the turn starts, or the read before
the send taking in the end of the previous turn. The writes a send makes on purpose are #767's.

Where the reads were. Before, each send's adapter reads were the coordinator's read before the send, the adapter's
own read at the start of the send, Claude's and Grok's recheck before the prompt, and, in all three, the coordinator's
reconciliation read after the provider accepted, made because the echo was still waiting in the workspace's publish
window. For Codex the first two were each a newest-turn check and the last a whole `thread/read`. Grok made one more
read before the send, for the coordinator's watched-set update, and reads its echo once after the prompt. After, one
read reaches each adapter, the coordinator's before the send. What is left of the history reads is that read,
Claude's and Grok's recheck just before the prompt, which the issue keeps, and Grok's read of its echo. No send in any
run made a reconciliation read.

### A Codex thread as it grows

`tests/perf/codexSendRead.perf.test.ts` sends five prompts from the Threads page to a Codex thread seeded with 50, 500
and 2,000 finished turns, through the coordinator over the Sotto thread host and the adapter, without the workspace.
It now also counts the newest-turn checks before `turn/start`. One run each.

| Turns | Send, before | Send, after | Newest-turn checks before `turn/start` | Whole reads |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 52 ms | 41 ms | 2 → 1 | 0 → 0 |
| 500 | 127 ms | 91 ms | 2 → 1 | 0 → 0 |
| 2,000 | 247 ms | 208 ms | 2 → 1 | 0 → 0 |

The `refreshThread` stage in that benchmark's output is now the coordinator's read alone: the adapter's own read
inside a send no longer calls `refreshThread`. Each row is a single run, so the times are sizes, not a measured
difference. One more run on the branch's head after review gave 41, 81 and 237 ms with the same counts.

After review, the read before a send names the send it is for, and the stack without a workspace answers the read
after a send from the adapter. Neither reaches this benchmark's path differently: one run on the branch's head gave
the same counts in every column above, with times 10-40 ms higher while another build ran on the machine.

## What these numbers are not

- The fake clients answer in a millisecond or two and hold short histories, so the times here are Sotto's own work
  and a small Node script, not a provider. Against a real client each history read removed is a round trip to it: a
  Grok `_x.ai/session/updates` request to the `grok agent` process, or a Codex `thread/turns/list`, which #324
  measured at 5-119 ms against Codex CLI 0.157.1 depending on the session file's size. No real client was run.
- The 1,000-exchange Claude thread costs about the same as the short one after the change, and about 10 ms more
  before it. With history kept from events, the snapshot the workspace asks for carries no messages, so of the four
  snapshots a send built before, only the adapter's own two copied messages. Copying keeps strings shared, and these
  filler exchanges make few activity records, so what those copies cost here is a lower bound, not what a long real
  thread costs.
- The recheck before the prompt is still a read for Claude and Grok, on purpose: someone can type into the session
  while the outbox and the message's origin are written, the session starts and images are read. The success path is
  one read before the send and that recheck. Codex's equivalent is its session-log poll, which is in process.
- Taken on the Windows development machine (Intel Core Ultra 9 275HX, Node v24.14.1) while another agent's build and
  tests ran on it, which is why some ranges are wide. Read them as sizes, not budgets. Nothing asserts a time; the
  counts are pinned by `tests/integration/sendReads.test.ts`.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/sendReads.perf.test.ts --maxWorkers=1 --disable-console-intercept
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/codexSendRead.perf.test.ts --maxWorkers=1 --disable-console-intercept -t "Threads page"
```

For the "before" figures, check out this branch's first commit, "Count what a send reads through the whole host
stack", and run the same commands.
