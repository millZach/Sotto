# The window hears when a voice starts and stops, not each microphone level - October 31, 2026

Part of #993. Measured on forge with two benchmarks, both rerunnable:

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/dictationLevels.perf.test.ts --maxWorkers=1 --disable-console-intercept
SOTTO_PERF_BENCH=1 SOTTO_PERF_DATA=<a Sotto data folder> NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/threadsRender.perf.test.tsx --maxWorkers=1 --disable-console-intercept
```

`dictationLevels` runs the real dictation controller through thirty seconds of seeded speech: phrases of 1.5 to 4
seconds with dips between words, and pauses of 0.4 to 1.5 seconds, one level every 33 ms as the recorder reports them.
It counts what the controller publishes. "Before" is the same file run on `origin/main` at `b00aa6ae9`.
`threadsRender` times what one publication costs the Threads page, in jsdom, on a copy of forge's host data (64 threads,
the open one with 1,119 messages, the second pane's with 552).

## What it cost

Every level the microphone reported was a publication. Each one:

- set the dictation state in the window's root context, so the whole app re-rendered, the Threads page included, whether
  it showed or not;
- crossed to main with a schema check of the widget snapshot;
- updated the tray and the Linux shell's state;
- re-rendered the widget.

The window and the widget used the level only to decide whether the wave moved. The one meter that shows the level, the
Dictate room's, also gives screen readers its value.

## The change

The speaking gate (`src/renderer/src/audio/speakingGate.ts`) is the wave's hysteresis, moved out of `ListeningBars`
unchanged: it opens above twice the recorder's silence floor, and closes below the floor only after the hold. The
dictation controller feeds each level through it and publishes only when it opens or closes. A listening snapshot
carries `speaking` instead of `level`. The level goes to a small live store that only the Dictate room's wave
subscribes to, so a level redraws that wave and nothing else. The microphone test still hands `ListeningBars` its own
level, and the bars gate it the same way.

## Before and after

| Thirty seconds of dictation (909 levels) | Before | After |
| --- | ---: | ---: |
| Publications (window root re-render, IPC, schema check, tray, widget render) | 909 | 19 |
| Publications a second | 30.3 | 0.63 |
| Main's schema checks | 909 x 41 us = 37 ms | 19 x 41 us = 0.8 ms |

| One publication on the Threads page (jsdom, forge data) | 1 pane | 2 panes |
| --- | ---: | ---: |
| Nothing changed (what a level cost) | 6.17 ms | 8.26 ms |
| Window time per second of speech, before | 187 ms | 250 ms |
| Window time per second of speech, after | 3.9 ms | 5.2 ms |

The window figures are jsdom on forge, which is slower than Chromium, so they are the ratio rather than the laptop's
milliseconds; #993's estimate of 20-40% of a renderer core matches their size. This pull request does not measure the
built app's renderer CPU during a dictation, which #993 also asks for.

## The guards

- `tests/perf/dictationLevels.perf.test.ts`, in the default suite: the 909 levels publish at most 21 snapshots, every one
  the gate opening or closing.
- `tests/unit/renderer/features/dictation/dictationLifecycle.test.ts`: each level reaches the meter alone, a snapshot goes
  only when the gate moves, and the meter rests and a pending close goes when listening ends.
- `tests/unit/renderer/audio/speakingGate.test.ts`: the hysteresis, the hold and the clamping the widget test checked before.
- `tests/unit/renderer/dictateRoomRedraw.test.tsx`: a level redraws the wave and its meter value, not the Journal.
