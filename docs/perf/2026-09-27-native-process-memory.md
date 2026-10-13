# Process memory with the native adapters - September 27, 2026

Issue #369, following #322. #322 asked for the memory of main, the renderer and the provider processes,
each on its own, before and after a change to how held histories are copied. That was not measured: the only
spec that took the in-app process split, `tests/e2e/multi-thread-cpu.spec.ts`, drives a synthetic provider on
the legacy snapshot contract, and the heap figures in `2026-09-26-snapshot-cloning.md` come from one Node
process with no renderer. This note adds a spec that runs the built app with the real Claude and Codex
adapters, records the split, and gives the figures before #322, after it, and after its follow-up #368.

In short: with eight held threads of 1,002 messages and no pane, main's heap is about 31 MiB with Claude and
36 MiB with Codex, its working set about 145 and 155 MiB, the renderer's about 141 and 145 MiB, and the fake
providers 527 MiB for eight Claude CLIs with their console hosts and 72 MiB for one Codex app server. #322 took
4.1 MiB off main's heap with eight Claude threads and nothing measurable with Codex. The later changes, #368
among them, moved no settled figure; they did shorten what main keeps for a minute after reading eight long Codex
histories, most likely through #352's faster open rather than #368.

## How it was measured

`tests/e2e/native-process-memory.spec.ts` launches the built app in a throwaway profile. A development-only
switch in `src/main/index.ts`, `SOTTO_E2E_NATIVE_FIXTURE_ROOT` with `SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE`, puts
the real `ClaudeStreamJsonHost` and `CodexAppServerHost` in the provider switch, each pointed at its fake CLI
under `tests/fixtures/` (`fakeClaudeThread.mjs`, `fakeCodexAppServer.mjs`) and run by Node. It is the Devin
fixture's switch (`SOTTO_E2E_DEVIN_ROOT`) for the other two adapters, and like it is read only when the E2E
boundary is on in an unpackaged app. Everything above the adapters is the app's own: the Sotto thread host, the
provider switch, the workspace, the coordinator, IPC and the window.

For each provider and for 1, 4 and 8 threads, one launch:

1. Connects the provider, leaves the Threads page for Dictate, so no pane shows a thread, and creates the
   threads in one project on the shared checkout. Each thread is sent one prompt, which opens its provider
   session: one CLI a thread for Claude, one app server for all of them for Codex.
2. Gives every thread a history of 1,002 messages: the first exchange and 500 filler exchanges of 154 and 616
   characters, the sizes the snapshot-cloning benchmark used.
   - Claude: each CLI streams the 1,000 filler messages and writes them to its session log, as Claude Code
     does, then finishes the turn (`raw-burst` with `persist`, then `complete`). That is one long turn, where
     the Codex threads have 500 turns, so the Claude figures leave out the per-turn activity a real Claude
     thread of 500 exchanges would also hold, and the two providers' per-thread costs are not like for like.
   - Codex: the fake adds 500 completed turns to each thread's history the way another Codex on the same
     session would (`native-turn` with `count`). Main then disconnects and connects Codex and watches every
     thread once, which reads each history whole, as the first pane on a thread does after Sotto starts, and
     stops watching them. Streaming the turns instead makes the adapter save its thread records once a frame,
     which took minutes for 2,000 frames and is not what a live turn does.
3. Waits until the shell reports 1,002 messages and an idle status for every thread. Every thread is now a held
   thread (`CONTEXT.md`): its session is open, and the reaper keeps an idle one for thirty minutes.
4. Measures with no pane (`noPaneAfterSeeding`): the window is on Dictate, and main has been told nothing is
   watched.
5. Opens the Threads page and presses the first thread's sidebar row, so one pane shows it, waits for its
   transcript, and measures (`onePane`).
6. Goes back to Dictate and measures again (`noPane`).

A measurement waits twenty seconds, forces three rounds of full collections in main (`gc` through `--expose-gc`,
set at run time) and in the window's renderer (`HeapProfiler.collectGarbage` through `webContents.debugger`), waits
a second, and takes five samples half a second apart. It reports the median of each: for main and the renderer the
working set, private bytes (Windows only) and V8 heap used; for everything else the working set. Main's working set
and private bytes do not follow its heap down at once: the pages it read the histories into stay committed for
somewhere between twenty seconds and a minute and a half after the collections free them, and then are released
together. The first no-pane figure usually still carries them, which is why the spec measures no pane a second
time, after the pane. `noPane` against `onePane` is the comparison the issue asks for; `noPaneAfterSeeding` shows
what reading the histories costs for that minute.

The window keeps the selected thread's history whether a pane shows it or not (`AgentContext.tsx`: "the thread
on screen needs its history"), so the renderer holds one thread's detail on Dictate too: the last thread created
before the pane, the first thread after it. The Electron processes come from
`app.getAppMetrics()`. The provider processes are main's descendants whose command line names the fake CLI,
from `Win32_Process` (`ps` on macOS); on Windows each of them also has a console host, counted beside it. The
spec prints sizes and counts only. It asserts no size, so it runs only under `SOTTO_PERF_BENCH=1`.

The provider figures are the fake CLIs'. The Codex fake keeps every history it was given; the Claude fake writes
what it streams to its session log and keeps almost nothing, so its figure is a Node process's baseline. They show
what Sotto's traffic costs a provider process, not what Claude Code or Codex hold, which is their own business.

## Results

The development machine: Windows 11, Intel Core Ultra 9 275HX (24 logical processors), 31 GiB, Electron 43.1.0,
Node v24.14.1. Other agents' builds and suites were running on it for most runs, and in the first runs its commit
charge was close enough to the limit that a process start failed with `spawn UNKNOWN`. The heaps barely move
under that load; the working sets move by a few MiB. Each figure below is the median of three runs, each of
them the median of five samples, with the range of the three runs in brackets where it is wider than 1 MiB.

Three revisions were measured, each with this spec and its three supporting changes applied:

- **Before #322**: `37cc4a99`, the first parent of the merge of #370, #322's pull request, in a scratch
  worktree with its own `npm ci`.
- **After #322**: `020df63a`, `main` when this work started.
- **After #368**: this branch with `main` at `7b5fdb84` merged in. Against `020df63a` that adds #368
  (refreshes and settings results without held histories), #352 (opening a long Codex thread), #373 (a Claude
  turn Claude Code starts on its own) and #371 (the host folder browser, which touches no adapter).

The before and after #322 runs were taken back to back; the after #368 runs about an hour later.

### Main

Heap used after the collections, and working set, in MiB, with no pane (`noPane`):

| Threads of 1,002 messages | Claude heap: before #322 | after #322 | after #368 | Codex heap: before #322 | after #322 | after #368 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 25.9 | 25.4 | 25.5 | 28.0 | 28.1 | 28.2 |
| 4 | 29.9 | 28.0 | 28.0 | 31.5 | 31.0 | 31.2 |
| 8 | 35.0 | 30.9 | 31.2 | 35.7 | 35.2 | 35.6 |

| Threads | Claude working set: before #322 | after #322 | after #368 | Codex working set: before #322 | after #322 | after #368 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 139.2 | 138.0 | 138.1 (138.0-140.3) | 148.6 (147.5-150.6) | 147.0 | 145.9 (145.1-147.5) |
| 4 | 145.1 (144.8-147.6) | 141.6 | 142.1 (141.3-144.1) | 152.6 (152.1-154.5) | 151.9 (151.7-154.2) | 150.3 (148.5-151.3) |
| 8 | 150.0 (149.8-153.7) | 144.9 | 144.8 (143.9-145.5) | 160.0 | 161.9 (159.2-162.2) | 155.5 (154.0-157.5) |

Private bytes follow the working set 35-40 MiB below it (8 Claude threads after #368: 109.2 MiB; 8 Codex
threads: 116.8 MiB). One pane instead of none changes main by less than the spread: main holds the same threads
either way, and the pane's thread is held already.

With Claude, #322 took 4.1 MiB off main's heap at eight long held threads and 1.9 MiB at four, which is the
provider switch's slot copy that `2026-09-26-snapshot-cloning.md` found (8.7 MiB there, where each history
was also held by the benchmark's own subscriber). The working set fell by 5 MiB at eight threads. Each held
Claude thread of 1,002 messages now costs main about 0.8 MiB of heap, against about 1.3 MiB before; its text is
0.4 MB. With Codex, #322 changed nothing that lasts: its histories arrive by a read rather than a stream, and
the read's copies do not stay in the switch's slot the way an activity snapshot's did. Each held Codex thread
costs main about 1.1 MiB. #368 changed no settled figure beyond the spread, as expected: it removes copies made
for a refresh or a settings result, which the next emit used to replace anyway.

What did change after #322 is the first no-pane figure, taken twenty seconds after main read eight Codex histories:
413 MiB working set before and after #322 (412.8-419.2), 343 MiB after #368 (339.3-403.0), with the same 35 MiB
heap. That memory is released a minute or so later either way (the `noPane` rows), so it is what opening many long
Codex threads costs for that minute, not what holding them costs. Which change moved it was not measured on its
own: #352 rewrote how a long Codex read is applied and is the likely cause, and #368 and #373 are in the same
build. With three runs and a range reaching 403 MiB, it is a hint rather than a result. The same figure for eight
Claude threads is 217 MiB after #322 against 151 MiB before; a burst of streamed history leaves its pages on a
different schedule, and the number says more about when V8 decommits than about what is held.

### Renderer

The window's renderer after #368, in MiB (before and after #322 were within the spread of these):

| Provider, threads | Working set, no pane | Working set, one pane | Heap, no pane | Heap, one pane |
| --- | ---: | ---: | ---: | ---: |
| Claude, 1 | 134.6 (133.4-135.8) | 140.6 | 20.0 | 20.1 |
| Claude, 4 | 137.3 (135.0-139.0) | 145.1 (144.6-147.6) | 20.3 | 20.7 |
| Claude, 8 | 141.0 (139.2-142.7) | 151.0 (148.4-151.4) | 20.7 | 21.0 |
| Codex, 1 | 137.3 (135.5-139.2) | 144.2 (143.3-144.8) | 20.1 | 20.3 |
| Codex, 4 | 140.1 | 150.4 | 20.3 | 20.7 |
| Codex, 8 | 144.7 (142.6-144.9) | 156.3 (155.4-158.1) | 20.7 | 21.2 |

The renderer's heap grows by about 0.1 MiB a thread: it holds the shell, which carries summaries rather than
histories, and one thread's detail window. A pane adds 6-12 MiB of working set, mostly layout and paint rather
than heap. Nothing in the renderer grows with how long a history is, which is what #322 and #368 left alone on
purpose.

### Providers and the rest

| Provider, threads | Provider processes | Their working set | Console hosts |
| --- | ---: | ---: | ---: |
| Claude, 1 | 1 | 57.6 (56.6-59.2) | 7.6 |
| Claude, 4 | 4 | 232.6 (226.4-237.2) | 30.5 |
| Claude, 8 | 8 | 466.0 (453.3-475.2) | 61.1 |
| Codex, 1 | 1 | 59.0 (57.7-60.2) | 7.6 |
| Codex, 4 | 1 | 62.0 (59.5-62.2) | 7.6 |
| Codex, 8 | 1 | 64.9 (62.8-65.5) | 7.6 |

Pane or no pane makes no difference here. A Claude thread costs a process of its own, about 58 MiB for the fake
and its 7.6 MiB console host, so eight held Claude threads cost three times what main does. The fake is a small
Node script; a real Claude Code process is larger, so the ratio is a floor. Codex keeps one app server for every
thread, and the fake grows by about 1 MiB a thread of 1,002 messages because it keeps each history it was given.
The provider figures did not change between revisions beyond the spread.

The other Electron processes do not depend on threads or panes: the GPU process 111-118 MiB, the utility process
48 MiB, and one other renderer, the floating widget, 107-113 MiB once settled (about 152 MiB in the first
measurement after launch). Added up, the working sets of a whole Sotto with eight held Claude threads and no
pane come to about 1,090 MiB, of which the providers are 527; with eight Codex threads, about 650 MiB. A sum of
working sets counts shared pages once for every process that maps them, so these totals overstate what the
machine gives Sotto.

### Spread

Heaps agree across the three runs of a revision to within 0.3 MiB. Settled working sets and private bytes agree
to within about 5 MiB, and the fake Claude processes to within about 20 MiB at eight. The first no-pane figure is
the one to distrust: its range reaches 60 MiB, depending on whether main had already let its pages go.

## Re-run

On an idle machine, after a build:

```powershell
npm run build
$env:SOTTO_PERF_BENCH = '1'
npx playwright test tests/e2e/native-process-memory.spec.ts --repeat-each=3
```

```sh
npm run build
SOTTO_PERF_BENCH=1 npx playwright test tests/e2e/native-process-memory.spec.ts --repeat-each=3
```

Each case prints one `native process memory:` line and writes the same figures, with the build's hash, to
`native-process-memory.json` in its Playwright output folder. To measure another revision, check it out in a
worktree under `.worktrees/` with its own `npm ci`, bring this spec and the three files it needs across
(`src/main/index.ts`'s fixture switch and the two fake CLIs' `persist` and `count` knobs), build, and run the same
command there on its own.
