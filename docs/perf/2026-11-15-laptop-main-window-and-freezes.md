# What keeps the laptop's Sotto busy, and why the laptop freezes (November 15, 2026)

The audit of November 10 found the laptop's Sotto main at 25% to 38% of a core and its window at 16% to 25% while forge's
host worked, with only a few percent of main explained by the wire (`docs/perf/2026-11-10-performance-and-data-audit.md`,
finding 8, #2397). On November 15 Zach also said the laptop had been freezing all day. This note says where main's
and the window's time goes now, and what froze the laptop. It reads CPU profiles, not traces: what the window spends on
layout, paint and compositing shows here only as native time and as the GPU process's CPU.

## How it was read

Everything here was read on the laptop without restarting Sotto or changing any other program:

- **Two activity recordings** (Record a minute, in Settings › Performance), each holding main's and the window's CPU
  profiles: at 19:59:40 UTC with the window shown on the Threads page, and at 20:01:34 with it minimized rather than
  covered. Owl `0.1.43-owl.20261114.1`
  (`9364826e8`). The profiles' frames were read against that build's own `out/main/index.js`.
- **Sotto's own hang recordings** from November 13 to 15 (`performance-recordings/sotto-hang-*`).
- **A sampler** from 19:57:17 to 20:22:15 UTC: `typeperf` once a second (CPU, DPC and interrupt time, available memory,
  pages a second, committed memory, disk queue, run queue), each process's CPU every 5 s, GPU 3D use by process every
  15 s, and a 250 ms sleep loop that logs any wake-up more than 750 ms late.
- **Windows' own logs**: Application and System errors since November 14, and WMI's activity log.

What else was running while it was read: three Sotto threads working (one on forge, two on the laptop), 14 Codex
app-servers and 5 Claude Code processes under Sotto, two Python file indexers outside Sotto, Rockwell's RSLinx Enterprise
services, Defender, Dropbox, Snagit and Autodesk's identity manager. The laptop has 24 logical cores and 32 GB of memory.

| Over the 25 minutes | Median | 95th percentile | Highest |
| --- | ---: | ---: | ---: |
| All CPU | 19.8% | 47.6% | 99.5% |
| Available memory | 14.3 GB | 15.7 GB (lowest 11 MB) | |
| Pages a second | 125 | 9,732 | 162,350 |
| Disk queue | 0 | 3 | 61 |

Beside each recording:

| | Shown, 19:59:40 | Minimized, 20:01:34 |
| --- | ---: | ---: |
| All CPU, mean and highest | 23.2%, 55.9% | 23.8%, 77.6% |
| Lowest available memory | 10.4 GB | 9.0 GB |
| Most pages a second | 15,185 | 1,875 |
| GPU 3D: `dwm`, `WUDFHost`, Sotto | 22%, 16%, under 1% | 21%, 15%, under 1% |
| The busiest other programs, share of a core | WMI 76%, Defender 67%, `dwm` 32%, an indexer 16% | `rustc` 188%, WMI 78%, Defender 45% |

## The freeze: the laptop ran out of memory

At 20:07:13 UTC committed memory went from 43 GB to 62 GB, above the 58 GB the page file allowed when the reading started.
Available memory fell from 9.4 GB to 11 MB by 20:07:20, the laptop paged 162,350 pages a second, and the CPU ran at 90%
to 99%, most of it in the kernel (`System` at 2 to 2.9 cores, Memory Compression at 1 core). It lasted about 11 s, and
the disk stayed busy for about 10 s after. A `rustc` and then five `link.exe` at about 80% of a core each were running:
an agent thread's Rust build, whose only target folder written then took 333 files between 20:05 and 20:09 UTC. Nothing
else started at that moment, so linking several debug binaries at once is the likely use of the memory. The sampler didn't
read each process's memory, so this is the likely cause rather than a measured one.

The sleep loop never woke more than 750 ms late, so the scheduler kept running through it. What freezes for the person
at the keyboard is every program waiting on memory that has been paged out.

## Sotto's own hangs

Main saved ten hang recordings from November 13 to 15. No window hang was saved. Each holds main's stack when it was
taken, so it says where main was then, not what took the whole time.

| Stopped at (UTC) | Length | Where main was |
| --- | ---: | --- |
| Nov 13 21:54:56 | 3.9 s | seeding records (`seedRecords` → `walk`) |
| Nov 14 01:45:09 | 5.7 s | no stack taken |
| Nov 14 17:27:32 | 2.9 s | restoring a checkpoint, then Watcher's thread edges |
| Nov 14 17:27:53 | 2.2 s | starting Claude Code (`child_process.spawn`, #2550) |
| Nov 14 17:37:17 | 1.6 s | starting Claude Code (#2550) |
| Nov 15 02:15:42 | 2.0 s | reading Claude's usage (`visitUsage`) |
| Nov 15 18:05:45 | 2.3 s | Watcher reading stored activity through zod |
| Nov 15 18:26:11 | 12.5 s | at 3.9 s, a Claude stream frame copying a thread's activity list in `certifyActivityView` (#2619) |
| Nov 15 18:26:47 | 1.9 s | reading a thread's message window |
| Nov 15 19:26:55 | 2.9 s | `createPage` |

None of them happened during the sampler, so none can be set beside a memory reading. The 12.5 s recording holds a
single stack, where a hang recording takes one a second; #2619 asks why.

## Main

| | Window shown | Window minimized |
| --- | ---: | ---: |
| Main's JavaScript, from its profile | 18.3% of a core | 1.5% |
| Main's process, from the sampler | 30.8% | 4.3% to 9.3% |
| Main's longest stop in the minute | 26 ms | 33 ms |

Main was busy in its JavaScript for 11.2 s of the shown minute:

| Part | ms | Share |
| --- | ---: | ---: |
| The window's publish (`WorkspaceHost`, `AgentControl.broadcast`) | 2,415 | 21.6% |
| Watcher's wake-up pass (`WatcherWakeUp.news` → `due` → `swarmPending`) | 2,225 | 19.9% |
| Watcher's room state to paired clients (`PairedClients.sendNow` → `WatcherService.state`) | 1,521 | 13.6% |
| Watcher's observe (`WatcherService.observe` → `recordSettled`) | 1,263 | 11.3% |
| Saving (`AgentControl.persist`) | 999 | 8.9% |
| Copies (`immutableUpdates`, `copyOver`) | 684 | 6.1% |
| Garbage collection and native | 540 | 4.8% |
| Claude stream frames, parsed and applied | 348 | 3.1% |
| Everything else | 1,177 | 10.5% |

Watcher's three parts are 45% of it. The hottest of its frames are lookups that search a whole list once per event, so
they grow with the record: #2618. The minimized minute can't be set against the shown one: its profile holds no Claude
stream frames at all, so the threads were quieter, and main's work fell as far as the window's. A range in these tables
is a process that fell out of the sampler's top eight in some samples: the low end counts those samples as nothing, the
high end as the eighth's share.

## The window

| | Window shown | Window minimized |
| --- | ---: | ---: |
| The window's JavaScript, from its profile | 6.9% of a core | 1.5% |
| Native time on the window's thread (`(program)`) | 2.9 s | 0.5 s |
| The window's process, from the sampler | 21.9% | 3.1% to 9.0% |
| Sotto's GPU process | 7.7% to 13.1% CPU, under 1% of the GPU | up to 8.9% CPU, under 1% of the GPU |

The window's largest JavaScript cost is sharing each new state with the one before (`share`, 1.2 s in the minute),
then keeping the newest shell in local storage every couple of seconds (`writeShellCache`, 0.4 s). Neither is worth
an issue at these sizes. Sotto's GPU process used under 1% of the GPU's 3D engine. The 3D engine's users were the desktop compositor (`dwm`, 21% on average) and a user-mode display driver host
(`WUDFHost`, 15%), which with three monitors is most likely the dock's display driver.

## Outside Sotto

| Program | What it does | CPU |
| --- | --- | ---: |
| WMI's provider host (`WmiPrvSE`) | answers other programs' WMI queries | 75% of a core on average, in every sample |
| Defender (`MsMpEng`) | scans files as they are written | 58% |
| The desktop compositor (`dwm`) | draws the desktop | 31% |
| A file indexer (`pythonw`) | indexes files outside Sotto | 6% |

What keeps WMI busy is Rockwell's **FactoryTalk Linx** (RSLinx Enterprise). Its `FTLinxServices.exe` and
`NetBrowserManager.exe` start the 32-bit `tasklist.exe` about once a second (30 in 40 s), and each asks WMI for every
process. WMI's log also holds about 18 a minute each of three hardware queries (the boot disk's serial number, its boot
partition and the computer's UUID). Over 1,100 came back cancelled in 22 minutes and were asked again, by short-lived
processes and by `MessagingPlugin.exe` under `UDClientService.exe`. WMI's load is steady, so it doesn't line up with
any one freeze, but it holds most of a core all day: 233,000 CPU seconds since November 11.

That indexer keeps starting AutoCAD's `accoreconsole.exe`, which crashes in `ODISSDK.dll`: 235 crashes since
November 14, in bursts of one every 3 to 7 s. None of the four hangs after 18:00 UTC on the 15th fell inside a burst: the nearest
crash to the 12.5 s hang was more than 10 minutes away.

## Against November 10

| | November 10 | November 15, window shown |
| --- | ---: | ---: |
| Main | 25% to 38% of a core | 31% |
| The window | 16% to 25% | 22% |
| Sotto's GPU process | 16% to 17% | 8% to 13% |

Since November 10, Watcher's progress goes to a paired desktop without the whole record (#2405), and a phone's shell leaves
out the parts no phone reads (#2404). The two readings had different threads and a different host behind them, so they
can't say how much of the difference those fixes made. Main is no lower than it was. What is left is its own work per
update, mostly Watcher's (#2618), rather than the wire.

## What this leaves

- **Sotto's, filed:** #2618 (Watcher's per-event searches, 45% of main's busy minute) and #2619 (the copy on the stream
  path in the 12.5 s hang, and the hang recording's missing stacks). Starting Claude Code blocking main is #2550.
- **Not worth an issue now:** the window's state sharing and shell cache, Sotto's GPU process and saving's 9%.
- **Outside Sotto:** Zach chose to cap every Rust build on the laptop at four jobs (`[build] jobs = 4` in his user cargo
  config), and to leave the indexer's AutoCAD step and FactoryTalk Linx as they are.
