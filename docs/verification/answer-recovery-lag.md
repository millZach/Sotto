# The desktop keeps up while an answer is held on a remote host — 2026-10-10

On 0.1.35 the desktop lagged by seconds (#914): clicks took seconds to land, typing trailed by several words, and one
send took over two minutes. [docs/perf/answer-recovery-passes.md](../perf/answer-recovery-passes.md) records the cause
and what one recovery pass costs. This note records the fix in the running app.

## What was driven

The development machine's own profile: 195 threads, all idle, this computer and forge as hosts, and one saved answer
held on a thread on forge. First the installed 0.1.35, then the packaged build of #915 (`npm run package:win`,
`release/win-unpacked/Sotto.exe`) on the same profile, after quitting 0.1.35 through `app.quit()`.

In each, real mouse clicks and keystrokes went to the main window: five threads in the sidebar, twice over, then a
click in the composer, a 43-letter sentence typed, and the composer cleared with Ctrl+A and Backspace. Nothing was
sent. Screenshots were taken after typing and again 1.5 s later. Main's inspector, opened on 127.0.0.1, measured
event-loop delay with `monitorEventLoopDelay` over 45 s and counted calls with non-pausing breakpoints. No message,
title or answer text was read.

## What it showed

| During the journey | 0.1.35 | #915 |
| --- | ---: | ---: |
| Main event-loop delay, 99th percentile | 1,536 ms | 58 ms |
| Main event-loop delay, longest | 2,995 ms | 586 ms |
| Main event-loop delay, mean | 116 ms | 12 ms |
| Main CPU | 112% | 22% |
| Main resident memory | 2,214 MB | 534 MB |

Idle for 30 s, 0.1.35's longest delay was 1,418 ms and #915's 202 ms. Right after typing, 0.1.35's composer was still
empty and the sentence appeared within the next 1.5 s; #915's composer showed the whole sentence with the caret after
it. During a second journey on #915, 74 published states asked for recovery, 30 passes ran, and `AgentControl.get()`
was called no times.

The screenshots stay on the development machine: they show the owner's thread titles and messages, and this
repository is public.
