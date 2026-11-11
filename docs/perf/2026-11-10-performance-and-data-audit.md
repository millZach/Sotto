# Performance and data audit - November 10, 2026

Zach asked for an audit of performance and of the data Sotto moves, on the desktop and the iPhone. This is that audit:
what was found, each finding's measurement and how to take it again, what it says about the issues already open, and a
set of new issues to choose from. Nothing in the app changed. No fix is started.

The headline: the benchmarks say Sotto's traffic is small, and on the fixture it is. On forge's running host it is not.
Two things the fixture does not hold make up almost all of what the host really sends: Watcher's record, sent whole to
the laptop up to twice a second, and about 205 KB of unchanged state sent again with every thread list push, to the
laptop and to an iPhone alike.

## What was measured, and where

- **The code:** `main` at `2fe2ca846` for every benchmark here. The iPhone benchmark ran on `65669cac1`, which `main`
  had reached by then.
- **Real traffic:** forge's own host, version `0.1.43-owl.20261110.1`, on the afternoon of November 10 with several
  threads working. Its laptop connection was read off the loopback interface. A throwaway phone was paired, sent the
  iPhone's own hello, and removed. Both tools keep counts, sizes and field names, never a message's words.
- **The laptop:** two 30-second readings of its Sotto processes over SSH, nothing run there.
- **Benchmarks:** the repository's own, on forge, one at a time. Times are forge's and read as proportions. Counts and
  bytes are exact.
- **The iPhone app:** the `iPhone benchmarks` workflow on a GitHub `macos-26` runner, `main` against the last commit it
  measured, November 5.

Not measured, and why, is at the end.

## Findings, ranked

Impact is how much it moves for the owner today. Effort is a guess at the size of the fix, not a design.

| # | Finding | The number | Impact | Effort |
|---|---|---|---|---|
| 1 | The host sends the laptop Watcher's whole record whenever a watched thread moves | 1.98 MB of JSON, up to 2.1 times a second. The laptop was sent 2.24 GB an hour over 38 minutes, and 90% of each two-minute tally was this | High | Medium |
| 2 | Every thread list push sends about 205 KB that did not change | iPhone: 6.76 MB a minute with a working thread open, 1.1% of it the reply. Laptop: 52 KB/s compressed | High | Small for the phone's unread parts, medium for the rest |
| 3 | The benchmarks do not hold what real traffic is made of | Fixture: Watcher's record 264 KB, no skill lists. forge: 2.49 MB and 115 KB a push | High, for every later fix | Small |
| 4 | An iPhone is sent nothing compressed, though it offers to take it | Hello 237 KB, 64 KB if compressed. A thread's step window 93 KB, 22 KB if compressed | Medium now, small after 2 | Small on the host, plus a check on a real iPhone |
| 5 | The iPhone fetches each picture whole to show it 640 pixels wide | Median picture 307 KB, 409 KB as sent. A sample at the size shown: 37 KB | Medium, high on picture threads | Medium |
| 6 | The iPhone connects from nothing each time it comes to the front | 657 KB per connect on forge, 13 connects in 35 minutes. The list of threads is 16 KB of each | Medium | Mostly falls out of 2 and 4 |
| 7 | Main's bundle has more than doubled since #995 was written, and #995 has not been started | Main 3.9 MB to 8.9 MB, the window's first scripts 4.1 MB to 7.8 MB. Launch to first paint on forge: 1.18 s | Medium | Small to medium, a piece at a time |
| 8 | The laptop's Sotto is busy and large while forge works | Main 25-38% of a core and 890 MB, the window 16-25% and 545-590 MB, the GPU process 16-17% | Unknown: not yet traced to a cause | Small to measure |
| 9 | Seven Claude Code processes sit under forge's host | 1.9 GB. Five are 2 to 5.6 hours old and used under 0.3 s of CPU in a minute | Low to medium | Small to explain, unknown to fix |
| 10 | The update check runs every four minutes | 16.7 KB a check, 360 checks and 6 MB a day | Low | Small |
| 11 | #2339 is forge's Node, not a regression | Node 26: 3 scenarios over budget. Node 24.22.1, CI's: all 24 pass | Low, but it costs every lane time | Small |
| 12 | Small costs that still hold | Composer 1.1-1.2 ms a chunk (#1969), 9.7 MB of usage ledgers read at start (#1937) | Low | As their issues say |

---

### 1. The host sends the laptop Watcher's whole record whenever a watched thread moves

**What happens.** A host keeps the requests and operations a desktop's Watcher has made there. It shows them to that
desktop as a projection, up to 1,000 requests and 1,000 operations, with a small list beside them of how far each watched
thread has got. The host builds the projection before every thread list push and sends it whole whenever anything in it
changed (`src/host/socketServer.ts:911-915`, `WatcherService.remoteProjection` in `src/main/agents/watcher.ts`). The
progress list changes with every step a watched thread takes. So a step in one thread sends every request and operation
Watcher has ever made on that host.

**Measured.** Two minutes of forge's host sending to the laptop:

| Message | Frames | On the wire | As JSON | Share of the wire |
|---|---:|---:|---:|---:|
| `watcher-state` | 254 | 92.9 MB | 502.0 MB | 90.0% |
| `shell` | 103 | 6.2 MB | 21.7 MB | 6.0% |
| Replies | 95 | 3.3 MB | 11.9 MB | 3.2% |
| `detail` (one thread opened) | 1 | 0.9 MB | 3.3 MB | 0.8% |
| All | 455 | 103.2 MB | 538.8 MB | |

- That is 860 KB a second, after compression. A second two minutes, with less work going on, carried 19.2 MB, 160 KB
  a second, in 48 Watcher pushes and 27 thread list pushes. Watcher's share was 91%. So the rate moves with the work
  and the share does not.
- The kernel's own counter for the connection (`ss -Htni`) rose by 1.42 GB over 38 minutes of the audit: 608 KB a
  second, 2.24 GB an hour, on average. It stood at 6.47 GB when the audit started, on a host 5.4 hours up.
- Each `watcher-state` push is 1.98 MB of JSON: requests 995 KB, operations 953 KB, progress 25 KB. Only the progress
  had changed.
- forge's record holds 925 requests and 929 operations, from October 28 to today. 920 of the requests are closed or
  stopped. Five are active.
- One push costs the host about 27 ms, nearly all of it compressing, and the laptop's main process about 16 ms: 4.6 ms
  to inflate, 3.0 ms to parse and 8.9 ms to check it against the schema. The benchmark builds its push from forge's
  whole saved record, 2.21 MB, which is 12% larger than the 1.98 MB pushes the tally saw, so these are estimates. That is forge's CPU, timing the wire work only. What the
  laptop then does with each projection is not in it: the reconcile benchmark
  (`tests/perf/watcherRemoteReconcile.perf.test.ts`, 1.5 to 1.9 ms a pass today) runs on a record of 253 to 260 KB.

**Take it again.**

```sh
ss -Htnp state established | grep MainThread     # the host's port and the client's
sudo python3 scripts/perf-bench/host-wire-tally.py --host-port 43299 --client-port 58518 --seconds 120
SOTTO_PERF_BENCH=1 SOTTO_AUDIT_WATCHER_RECORD=$HOME/.sotto/watcher-record.json NODE_OPTIONS=--max-old-space-size=3072 \
  npx vitest run tests/perf/watcherStatePush.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

Evidence: `docs/perf/data/2026-11-10-audit/live-host-to-laptop-1.json` and `-2.json`,
`watcher-state-push-forge-record.json`.

**Why nobody saw it.** `docs/perf/2026-10-31-watcher-reconcile.md` took the record to be held near 250 KB by pruning.
forge's, a host's record of what the laptop's Watcher asked of it, is 2.49 MB on disk. The data-transfer benchmark's desktop does not ask for Watcher's projection at all.

**What a fix could be.** Send the progress list apart from the record, since the desktop needs no read and no write for
a progress-only change (`docs/host-protocol.md`, "Watcher on a paired host"). Or send only requests that are still open
and let the desktop read a closed one when it asks. Either is a new host feature beside protocol version 1, not a change
to it. The measure of success is `watcher-state` bytes a minute from the same tally.

**Existing issues.** None covers it. #1759 is about the window and main with a long Watcher thread, not this push.

---

### 2. Every thread list push sends about 205 KB that did not change

**What happens.** A thread list push (`shell`) carries the host's whole state. Two parts of it are already sent only
when they change: the model catalog, by revision, and the thread records, as changed thread records. Everything else
goes whole every time. The window stopped being sent these parts on October 30 (#1940, kept parts). A socket client
still gets them.

**Measured on forge's host, one push:**

| Part of a push | Bytes | Does the iPhone read it? |
|---|---:|---|
| `skillCatalogs` | 115,223 | No |
| `deliveries` | 45,933 | Yes |
| `deliveredDrafts` | 12,929 | Yes |
| `obsoleteDrafts` | 12,929 | No |
| `followupReceipts` | 7,980 | Yes |
| `host.projects`, `host.providers` | 6,106 | Yes |
| `clientUpdates`, `threadDrafts`, `threadDraftPersistence` | 3,282 | No |
| **Changed thread records, the news** | about 3,000 | Yes |
| A whole push | about 209,000 | |

`skillCatalogs` is each thread's list of skills, kept for every thread whose list was read since the host started. It
has no limit. The three ledgers are at their limit of 128 entries. The iPhone decodes fifteen named fields of a shell
(`apps/ios/Sources/SottoCore/Wire.swift:169`) and none of the parts marked No, which are 131 KB of every push, 63%.

**What it adds up to, to an iPhone (nothing compressed):**

| The iPhone is | Seconds | Sent | Of it, news |
|---|---:|---:|---:|
| On the Threads list, threads working on the host | 60 | 3.77 MB in 18 pushes | 55 KB, 1.5% |
| On an open, working thread | 60 | 6.76 MB: 32 pushes, and 63 updates to the reply | 75 KB of reply, 1.1% |

An hour watching a thread work is about 400 MB. The reply the user is reading is about 4.5 MB of it.

**To the laptop (compressed):** 103 pushes in two minutes, 210 KB of JSON each, 60 KB on the wire: 52 KB a second. The
news in each was 4.2 KB.

**It has grown.** `docs/perf/2026-11-02-iphone-command-reply-threads.md` measured the same push at 87 KB on November 2
and listed it under what is left. It is 209 KB today. The difference is `skillCatalogs`, which that capture did not
hold. No issue was filed from that note.

**Take it again.**

```sh
node scripts/perf-bench/phone-wire-probe.mjs --data ~/.sotto --list-seconds 60 --thread-seconds 60
```

It pairs a throwaway phone with the host on this machine, sends the iPhone's hello read from the Swift source, sends
nothing but hello, observe and pings, opens only a thread with no unread mark, and removes its pairing. Evidence:
`forge-host-to-phone-1.json`, and `live-host-to-laptop-1.json` for the laptop's side.

**What a fix could be.** Two steps, the first small:

1. Leave out of a phone's shell the parts no phone reads. That is 131 KB of each 209 KB push with no change to either
   app. The Android client's `Wire.kt` names none of those fields either.
2. Send a socket client the remaining parts only when they change, as the window is sent them. That needs a host
   feature and the clients to keep each part.

**Existing issues.** This is what #996 has left, measured. Its November 6 comment names "per-thread shell deltas" as
left. The thread records are in fact already sent as changes. What is left is every other part of the shell.

---

### 3. The benchmarks do not hold what real traffic is made of

**What happens.** The data-transfer benchmark (`tests/perf/dataTransfer.perf.test.ts`) runs on the owner-scale fixture.
It reports a streaming thread as 9 KB a push to a desktop and 269 bytes to a phone. Both are right for the fixture.

**Measured, fixture against forge:**

| | Fixture | forge's host |
|---|---:|---:|
| Watcher's record | 264 KB | 2.49 MB |
| Requests and operations in it | 160 and 150 | 925 and 929 |
| `skillCatalogs` in a shell | none | 115 KB |
| A shell push to a desktop while one thread works | 8.9 KB | 210 KB |
| `watcher-state` pushes to the desktop | none: its desktop does not ask | 90% of the bytes |
| The phone's `accepts` | 8 features | 20, as the iPhone has sent since November 5 |

So the benchmark could not have caught finding 1 or the growth in finding 2, and a fix to either would show no gain on
it.

**Take it again.** The fixture's numbers: `SOTTO_PERF_BENCH=1 SOTTO_AUDIT_SOCKET=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/dataTransfer.perf.test.ts -t "host socket" --maxWorkers=1 --disable-console-intercept`.
Evidence: `data-transfer-socket.json`, `data-transfer-window.json`.

**What a fix could be.** Give the fixture a Watcher record and skill lists the size of forge's, have its desktop accept
what the real desktop accepts and its phone send the iPhone's own list, read from the Swift source as the probe does.
Then add a guard on bytes per push. This comes first if findings 1 and 2 are to have a before and after in CI.

---

### 4. An iPhone is sent nothing compressed

**What happens.** The host compresses for a desktop and never for a phone (`compresses()` in
`src/host/socketServer.ts`). ADR-0025's October 18 amendment leaves phones out until it is checked on a device.

**Measured on forge's host today, each frame compressed alone as a desktop's is:**

| | As sent | If compressed | Ratio |
|---|---:|---:|---:|
| Hello | 237 KB | 64 KB | 3.7 |
| A thread opened: its step window | 93 KB | 22 KB | 4.1 |
| A minute on a working thread | 6.76 MB | 1.97 MB | 3.4 |

After finding 2 is fixed the pushes are small either way. What compression still saves is most of each hello and of
each thread opened.

**Take it again.** The same probe as finding 2 prints both columns.

**The iPhone does offer it.** The app sets no header for compression, and the November 2 note left open whether
`URLSessionWebSocketTask` offers it by itself and whether Tailscale Serve passes the offer on. A watcher on forge's
listener logged each upgrade's offer for 40 minutes of this audit. Thirteen times a client whose User-Agent names
`Sotto`, `CFNetwork` and `Darwin`, the iPhone app, arrived through Serve with
`Sec-WebSocket-Extensions: permessage-deflate`.
`deflateOffered` in `src/host/socketFrames.ts` already accepts an offer of that form. So `compresses()` is the only
thing in the way on the host. What is still not known is whether the iPhone reads a compressed frame correctly, which
takes a build that is answered with one. Evidence: `iphone-upgrade-offer.txt`, taken with
`scripts/perf-bench/upgrade-offer-watch.py`.

**Existing issues.** None. The November 1 and November 2 notes both list it under what is left.

---

### 5. The iPhone fetches each picture whole to show it 640 pixels wide

**What happens.** A picture tile on the iPhone asks for the picture with `thread-media`, which answers the whole file as
base64. The app then makes its own 640-pixel copy (`PhotoPipeline.thumbnailEdge`) and keeps up to 150 in memory. Nothing
is kept on disk, so a new launch fetches again. A sent photo's thumbnail (`preview`) works the same way.

**Measured on forge's kept pictures:**

- 2,707 pictures, 1.07 GB. The median is 307 KB, which is 409 KB as base64. The mean is 396 KB.
- Forty of them, picked at random, made into 640-pixel JPEGs at quality 80: median 37 KB against 332 KB whole.
  Together 17.9 MB became 1.62 MB, about an eleventh.
- A thread's step window on the iPhone holds its newest 200 steps (ADR-0194). The design thread held 680 pictures in
  2,000 steps on November 5, so about 68 in a window: about 28 MB if every tile is scrolled past. That is worked out,
  not measured.

**Take it again.** `python3 scripts/perf-bench/picture-sizes.py ~/.sotto/thread-media 40`

**What a fix could be.** Let a phone ask for a picture at a size, and have the host answer a reduced copy, as main
already makes thumbnails for the window (#2199, #2201). The whole picture still comes when the user opens it.

**Existing issues.** None open. `docs/perf/2026-11-05-iphone-step-window.md` notes "about 250 KB each" and leaves it.

---

### 6. The iPhone connects from nothing each time it comes to the front

**What happens.** Going to the background closes every socket. Coming back runs a whole connect for each computer: a
health read, a new session, the socket, a hello that carries the catalog and every listed thread again, then observe.
Pull to refresh does the same. Nothing is kept across connections or launches, so after a cold launch the Threads list
is empty until hello returns (read in `apps/ios/Sotto/AppModel.swift` and `HostConnection.swift`).

**Measured on forge's host:** the owner's iPhone connected 13 times in the 35 minutes the offer watcher of finding 4
ran, from 15:23 to 15:58. One connect is sent 657 KB in its first two seconds, so those were about 8.5 MB before a
thread was read: the hello, 237 KB, and two shell
pushes, 420 KB. Of the hello, 131 KB is the parts the iPhone does not read, and the threads it lists are 16 KB. The laptop's hello was 321 KB on November 1
(`docs/perf/2026-11-01-phone-connect-size.md`) and was not measured again; see what was not measured.

**What a fix could be.** Findings 2 and 4 would take a forge connect from 657 KB to about 30 KB without touching this;
that figure is worked out from the parts' sizes, not measured. Keeping
the last list on the phone, so a launch shows threads before the hello returns, is a product decision: it puts thread
titles on the phone's disk, where today only the Keychain holds anything.

---

### 7. Main's bundle has more than doubled since #995 was written

**Measured, the build of `2fe2ca846` against #995's figures from October 12:**

| | October 12 (#995) | Today | |
|---|---:|---:|---:|
| Main's bundle | 3.9 MB | 8.92 MB | 2.3 times |
| The preload, loaded by each window | 376 KB | 691 KB | 1.8 times |
| The window's first scripts | 4.06 MB | 7.8 MB | 1.9 times |
| The window's main stylesheet | 524 KB | 843 KB | 1.6 times |

The window's first scripts are `main` (4.87 MB), `interfaceLanguage` (1.37 MB), `global` (1.51 MB) and two small ones,
all loaded before React starts. The renderer is still not minified.

**Launch, on forge under a virtual display, an empty profile, the median of five after a warm-up:**

| | |
|---|---:|
| Asked to the window's page starting to load | 674 ms |
| Page start to first paint | 508 ms |
| Asked to first paint | 1,182 ms (1,165 to 1,236) |
| At rest: six processes | 1,017 MB working set, 0% CPU |
| Of it: main, the two windows, the GPU process | 322 MB, 393 MB, 136 MB |

This is Linux on a fast machine with no threads. It is a baseline for a change to be measured against, not what the
laptop feels. #995 asked for Windows and macOS, cold and warm, and for timing marks in the app; neither exists yet.

**Take it again.**

```sh
npm run build && ls -l out/main/index.js out/preload/index.js out/renderer/assets/main-*.js
SOTTO_PERF_BENCH=1 SOTTO_LAUNCH_RUNS=5 xvfb-run -a -s '-screen 0 1920x1080x24' npx playwright test tests/e2e/launch-time.spec.ts
```

Evidence: `launch-time-forge.json`. The spec runs on Windows too, without `xvfb-run`.

**Existing issues.** #995 holds and is larger than when it was written. The two items checked here, timing marks and a
minified window, are not done, and the issue has had no comment or linked change since October 13.

---

### 8. The laptop's Sotto is busy and large while forge works

**Measured.** Two 30-second readings of the laptop's Sotto processes, an Owl build, while forge's threads worked and the
host sent it 330 to 860 KB a second:

| Process | CPU, share of one core | Working set |
|---|---:|---:|
| Main | 38.4%, 24.6% | 890 MB |
| The main window | 24.6%, 15.7% | 588 MB, 543 MB |
| The GPU process | 16.0%, 17.4% | 335 MB |
| Every Sotto process | about 60% to 80% | about 2.15 GB |

**What is and is not explained.** The wire work of finding 1 is about 3.5% of a core on main by the benchmark's
estimate, and finding 2's about 1%. That leaves most of main's 25-38% unexplained. A GPU process at 16% while nothing is being typed
means something on the page is drawing all the time. Neither was traced: that needs a profile of main and a trace of the
window on the laptop, which this audit did not take.

**Take it again.** `scripts/perf-bench/sotto-processes.ps1` on the laptop, in PowerShell. It only reads the process
list.

**Existing issues.** #993's last item (a covered window on Windows still draws) and #1759 are the nearest. Neither
explains a main process at this level.

---

### 9. Seven Claude Code processes sit under forge's host

**Measured.** The host's children at one moment: seven `claude` and one `codex`, 2,093 MB together. Over one minute,
five of the Claude processes used 0.14 to 0.25 seconds of CPU. They were 122 to 339 minutes old. The reaper stops a
session idle for 30 minutes unless its thread is busy, holds an unanswered request, or is in the live-session set.

**What is not known.** Which rule keeps each one. They may all be held rightly, for example by a question waiting for an
answer. This audit could not match a process to its thread's state from outside the host.

**Take it again.** `python3 scripts/perf-bench/host-children.py <the host's pid> 60`

**Existing issues.** #992's "viewing a Claude thread starts a process" is fixed (#1974). This is what is left of the
memory it described: 210 to 360 MB a session for as long as it is held.

---

### 10. The update check runs every four minutes

**Measured.** Each check reads the release feed, 16,352 bytes and not compressed, then a 395-byte manifest. At one every
four minutes that is 360 checks and about 6 MB a day on each desktop, with no conditional request. Each connected client
is also checked against its registry every five minutes on every machine: 1.0 to 1.5 KB compressed for each of up to
five packages. With the window in front, `git fetch` runs every 30 seconds for the threads in view.

The scout's inventory found 42 places Sotto reaches an outside host. None runs often besides these. The product events
sender is off until the notice is answered.

**Take it again.** `curl -sL -o /dev/null -w '%{size_download}\n' https://github.com/millZach/Sotto-releases/releases.atom`.
The intervals are `UPDATE_CHECK_INTERVAL_MS` and `CLIENT_CHECK_INTERVAL_MS`.

---

### 11. #2339 is forge's Node, not a regression

**Measured.** `tests/perf/ownerScaleWorkBudget.perf.test.ts` at `2fe2ca846`, the same checkout and `node_modules`:

| Node | Result |
|---|---|
| 26.12.0, forge's default | 3 failed: one thread streaming on Owl (218.31 thread reads against 218.23), and a send on Owl (5,407 against 4,146) and on stable (11,754 against 10,122) |
| 24.22.1, the version CI uses | 24 passed |

So `main` is inside its budgets where they are enforced. The counts differ by Node version, which the budgets' "the
same on every run" does not allow for.

**Take it again.**

```sh
npx vitest run tests/perf/ownerScaleWorkBudget.perf.test.ts --maxWorkers=1
PATH=$HOME/.local/share/mise/installs/node/24.22.1/bin:$PATH npx vitest run tests/perf/ownerScaleWorkBudget.perf.test.ts --maxWorkers=1
```

Evidence: `owner-scale-over-budget-node26.txt`.

**What a fix could be.** Pin the repository's Node with a `.node-version` file so mise picks CI's version on forge, and
close #2339. Why the counts differ under Node 26 only matters when CI moves to it.

---

### 12. Small costs that still hold

- **#1969, the composer under a streaming pane.** On forge's data in jsdom, a chunk on the open thread costs 24.2 ms an
  update, 7.6 ms of it React's and 1.2 ms the composer's; with two panes 1.06 ms. The issue said 0.84 to 1.82 ms. It
  holds and it is small. `SOTTO_PERF_BENCH=1 SOTTO_PERF_DATA=$HOME/.sotto npx vitest run tests/perf/threadsRender.perf.test.tsx --maxWorkers=1 --disable-console-intercept`
  under Node 24.
- **#1937, usage ledgers read at start.** forge holds 152 ledgers, 9.68 MB. Parsing them alone takes 38 ms. The issue's
  9.8 MB still stands, and it is once a start. `node scripts/perf-bench/usage-ledger-sizes.mjs ~/.sotto`
- **Whole-file saves.** The host wrote 9.0 MB to disk in two minutes of work, read from `/proc/<pid>/io`. On the
  fixture a send rewrites `workspace.json` three times, 384 KB each. Not worth a change by itself.
- **The window's own channel is small.** One thread streaming sends the window 61 state messages of 2.7 KB and 60 reply
  updates of 220 bytes in four seconds. The October work holds.
- **A background turn's read-back** holds at 72 KB sent to the store worker, where it was 12.5 MB
  (`docs/perf/2026-10-30-background-turn-readback.md`).

---

## The iPhone app, measured today

[Run 42919564939](https://github.com/millZach/Sotto/actions/runs/42919564939) measured `main` at `65669cac1` against
`3e2ee9b79`, the last commit the iPhone benchmarks measured (#2206, November 5), on one `macos-26` runner. 46 commits
touched `apps/ios` between them, among them videos, pictures in steps, skipping questions and the step window. The run
passed: every work-count budget held and the long thread looks the same.

**What it can say: the app does no more work than on November 5.**

| | November 5 | Today |
|---|---:|---:|
| Message bodies built to open the long thread | 27 | 27 |
| Text views made to open it | 31 | 31 |
| Message bodies per streamed word | 1.00 | 1.00 |
| The Threads list's bodies per streamed word, worst journey | 0 | 0 |
| Memory with the long thread open | 122 MB | 111 MB |
| Memory scrolling it | 136 MB | 124 MB |
| Peak memory over the journey | 187 MB | 187 MB |

**What it cannot say: whether anything got slower.** The run measures the base and then the change, about 25 minutes
apart. SottoCore's own benchmarks ran 1.1 to 2.9 times slower in the second half, among them ones whose code did not
change (`core.markdown-200.blocks` 15.6 to 31.3 ms, `core.shell-full.read` 7.6 to 8.6 ms). The app's timings moved
less than that, so they are inside the runner's drift:

| | November 5 | Today |
|---|---:|---:|
| Launch to the Threads list | 4,623 ms | 5,762 ms |
| Open the long thread, tap to drawn | 3,355 ms | 3,137 ms |
| CPU per streamed word | 72.7 ms | 83.4 ms |
| Late time while streaming | 593 ms/s | 642 ms/s |
| Late time scrolling the thread | 349 ms/s | 400 ms/s |

One row stands out and is worth an interleaved run before anyone calls it a regression: growing and shrinking the reply
box. Its late frames went from 48 to 120 and its late time from 94 to 279 ms a second, while its CPU did not move (4,085
to 4,006 ms).

**Where the iPhone still is, on either column.** On a 200-turn thread in the simulator, the screen is late for about
60% of every second a reply streams, a streamed word costs 73 to 83 ms of CPU, opening the thread holds the main thread
for about 3 seconds, and scrolling it is late for 35% to 40% of each second. These are #1702's and #2120's, and they
hold. Simulator figures compare builds; they are not a phone's.

**The benchmark feeds the app less than a host does.** Its stream sends a thread list push of 2,075 bytes after every
fifth word. forge's host sends 209 KB (finding 2). Reading a list of 287 KB takes SottoCore 7.6 to 8.6 ms on the
runner's Mac and 62 to 84 ms inside the simulator at launch, so a real push costs the iPhone work the benchmark never
gives it.

Evidence: `iphone-benchmarks-run-42919564939.md`. Take it again: `gh workflow run ios-perf.yml --ref main -f base=3e2ee9b79`.

### What the code says about idle and battery, not yet measured

These were read in the app's source by a scout and are listed so they can be measured. None is a finding yet.

- The Threads list and an open thread both run a background wash that drifts for ever, 26 seconds each way, unless
  Reduce Motion is on. A working thread adds a breathing dot, a glow, a streak and a one-second clock.
- The only network traffic of an idle, connected iPhone is a ping every 25 seconds.
- There is no handling for cellular or Low Data Mode, no background task and no push. All sockets close in the
  background.
- The iPhone benchmarks have no idle phase, so none of this has a number.

## What this says about the open issues

| Issue | Still holds? | How big, measured today | Suggested |
|---|---|---|---|
| #996 Send remote clients only what changed | Yes, in part | Thread records are already sent as changes. Every other part of the shell is not: 205 KB a push, finding 2. The desktop's second whole read on a click (#1990) was not measured again | Update with finding 2's numbers, or close in favour of the new issues |
| #993 Stop the window rendering what nobody sees | Only its Windows item | `CalculateNativeWinOcclusion` is still turned off (`src/main/index.ts:2882`). The November 1 figures stand: 20% of a core covered against 1.4 to 3.6%. Not measurable from forge | Keep, held as it is |
| #995 Show the main window sooner at launch | Yes | Bundles 1.6 to 2.3 times their size then. First paint 1.18 s on forge. Finding 7 | Update with today's sizes |
| #992 Stop paying for saved history and idle processes | Done but for the slow sweep Zach chose not to build | Idle sessions still hold 1.9 GB on forge, finding 9, which may be by the rules | Close on Zach's word; finding 9 is its own question |
| #1248 Work in main that grows with history | Nearly done | One entry is left in `KNOWN_HISTORY_GROWTH`: two extra Watcher look-ups per answer-draft save. The budget test passes on Node 24 | Close, or keep for that one entry |
| #1937 Read usage requests only on first use | Yes | 9.68 MB in 152 files, 38 ms to parse at start | Keep parked |
| #1969 Composer under a streaming pane | Yes | 1.06 to 1.2 ms a chunk | Keep, low |
| #2339 Send scenarios over budget on forge | Answered | Node 26 fails, Node 24.22.1 passes. Finding 11 | Close with a Node pin |
| #1990 A remote thread sent whole twice | Not measured again | One whole detail to the laptop was 3.27 MB of JSON, 852 KB on the wire | Keep |
| #1702 Rank the iPhone's own lag suspects, and #2120 | Yes | Late for about 60% of each second while a reply streams, 73 to 83 ms of CPU a word, about 3 s to open a 200-turn thread, in the simulator | Keep. No more work than on November 5 |
| #1938 Bound the usage ledger | Not measured again | Ledgers are 9.68 MB today against 9.8 MB on November 1 | Keep parked |

Earlier work checked and holding: #1818 (the desktop no longer copies each push or reads its catalog again), the
background turn's read-back, #1940 (the window's kept parts: 2.7 KB a message while a thread streams) and #2252 (the
iPhone's step window: 93 KB for a thread opened). #167 and #247, September's fixes, are under these and were not measured
apart.

## Proposed new issues

Each has the measure that says it is done. Zach chose on November 10 to file all of them and to fix them in turn,
starting with D, then A and B; the numbers are the issues filed.

| | Issue | From | Done when |
|---|---|---|---|
| A, #2391 | Send a paired desktop Watcher's progress without the whole record | Finding 1 | `watcher-state` bytes a minute from `host-wire-tally.py` on forge fall from about 46 MB to under 1 MB with the same threads working |
| B, #2392 | Leave out of a phone's thread list the parts no phone reads | Finding 2, step 1 | A push in `phone-wire-probe.mjs` falls from about 209 KB to under 80 KB, with the iPhone and Android journeys unchanged |
| C, #2393 | Send a socket client the unchanged parts of the thread list once | Finding 2, step 2; finishes #996 | A push that changes one thread is under 10 KB to a phone and to a desktop |
| D, #2390 | Make the transfer benchmark hold what forge's host holds | Finding 3 | The fixture's push sizes are within a quarter of forge's, the phone sends the iPhone's own `accepts`, and a guard fails when a push grows |
| E, #2394 | Compress what an iPhone is sent | Finding 4 | A real iPhone reads a compressed hello from forge of under 70 KB, and ADR-0025 says phones are in |
| F, #2395 | Send the iPhone a picture at the size it shows | Finding 5 | A tile's fetch is under 60 KB at the median, and the full picture still opens |
| G, #2396 | Take up #995 a piece at a time, starting with timing marks and a minified window | Finding 7 | Each piece shows its before and after from `launch-time.spec.ts` on Windows |
| H, #2397 | Find what keeps the laptop's main and GPU processes busy while a host works | Finding 8 | A profile names the top costs, and each becomes its own issue or is closed |
| I, #2398 | Say why each idle provider session is still held | Finding 9 | A debug read lists each held session with the rule that holds it |
| J, #2399 | Check for a Sotto update less often | Finding 10 | Zach picks the interval |
| K, #2339 | Pin the repository's Node version | Finding 11; closes #2339 | The budget test passes on forge without a `PATH` change |
| L, #2400 | Add an idle phase to the iPhone benchmarks | The unmeasured list | CPU and frames drawn for 30 idle seconds on the Threads list and on a thread are in the summary |
| M, #2401 | Measure the iPhone's reply box against November 5 in turns on one runner | The iPhone run | Late frames while the reply box grows and shrinks are the same in both builds, or the commit that raised them is named |
| N, in #2390 | Feed the iPhone benchmarks a thread list push the size a host sends | The iPhone run, finding 3 | The stream's push is the size `phone-wire-probe.mjs` reads from forge, until finding 2 is fixed |

A, B and D are the three that change the most for the least. A and B do not depend on each other. D makes both
provable in CI rather than only on forge.

## What was not measured

- **The laptop sending to the iPhone.** The iPhone pairs with the laptop too, and the laptop's shell also carries
  Watcher's page, 207 KB on November 1. Measuring it means pairing a throwaway phone on the laptop, which writes an
  answer grant there, so it waits for Zach's word.
- **Windows.** Launch time, a covered window and the renderer at rest were not run on the laptop, by the rule that it
  runs no suites. `launch-time.spec.ts` is ready to run there.
- **A real iPhone on cellular.** Every phone number here is what the host sends, counted on forge. Radio time and
  battery were not measured. The simulator benchmarks compare builds and say nothing absolute about a phone.
- **Sending from the iPhone.** The iPhone benchmarks' journey never sends a reply, so how smooth a send is has no
  number here. #2301 (a medium thread moves 16 points just after Send) and #2246 are the open issues on it.
- **Bytes to outside services per action.** Only the update check and the client registry checks were sized
  (finding 10). What one AI cleanup request, one cloud dictation segment, a theme search or a cloud iPhone session
  sends and receives was not measured: each runs on a press or a dictation and needs its key. The inventory of where
  Sotto reaches an outside host was read from the code, not captured.
- **Why the laptop's main process is busy** (finding 8), and **which rule holds each idle session** (finding 9).
- **The desktop's second whole read of a remote thread** (#1990), last measured November 1.

## Side findings, not followed

- `README.md` names Meshy's hosts under "Privacy and cost", and `AGENTS.md` describes ADR-0141's standing exception.
  `grep -ril meshy src` finds nothing: the feature is not in the app.
- `src/main/updates/updateService.ts` says each update check is "one small request". It is two.
- A scout read `compresses()` as true for any client that offers compression on a headless host's own listener when no
  tailnet record is passed, where the comment above it says no phone is ever compressed. Not checked.
- `process.getCreationTime()` in Electron on Linux disagreed with the wall clock by most of a second, so the launch spec
  does not use it.

## What this branch adds

Tools for measuring, and evidence. No app code.

- `scripts/perf-bench/host-wire-tally.py`: what a running host sends one client, by message and field name.
- `scripts/perf-bench/phone-wire-probe.mjs`: what a running host sends an iPhone, per action.
- `scripts/perf-bench/host-children.py`, `picture-sizes.py`, `sotto-processes.ps1`, `upgrade-offer-watch.py` and
  `usage-ledger-sizes.mjs`: the small readings above.
- `tests/perf/watcherStatePush.perf.test.ts`: what one Watcher push costs each end.
- `tests/e2e/launch-time.spec.ts`: launch to first paint, and memory at rest.
- `docs/perf/data/2026-11-10-audit/`: the output of each, sizes and counts only.

The two test files skip unless `SOTTO_PERF_BENCH=1` is set, so no gate runs them.
