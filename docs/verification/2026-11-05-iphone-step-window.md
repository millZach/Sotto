# The iPhone's picture thread holds still while its oldest steps are dropped - November 5, 2026

#2242: on the iPhone, the design loop thread jumped under its reader while it worked, after #2202. A thread keeps at most
2,000 step records, and that thread is at the cap: it has dropped 19,405 steps, and the oldest it holds carry a picture every
two to five steps. Each new step drops the oldest, at the top of the page, and the rows below move up by what left. #2202's
fixture holds about 1,400 steps and never reaches the cap.

## How it was checked

The picture journey (`--bench-journey pictures`) on the design loop thread's shape: its newest ten turns counted as message
lengths, steps and pictures per run, none of its words. The app holds the page still in the middle of the thread and inside
the run that is growing while the thread works (30 updates over 15 seconds each), and reads, every frame, where the message
row nearest the middle of the screen sits on screen (`--bench-row-frames`). Three arms:

- `today`: the thread whole, as the phone opens it now; new steps added.
- `cap`: the same, but each new step drops the oldest, as Claude's adapter does at 2,000 (`activities.slice(-2000)`).
- `window`: the thread as a host with a step window sends it (ADR-0194), with each new step dropping the oldest too.

Debug built optimized, on GitHub's `macos-26` with Xcode 26.6, two cold launches per arm and phone. Scratch runs
[42120585078](https://github.com/millZach/Sotto/actions/runs/42120585078) (today and cap) and
[42125391747](https://github.com/millZach/Sotto/actions/runs/42125391747) (all three); the two rounds of every arm read the
same.

## What the page did

How far the held row moved, in points:

| Phone | Phase | today | cap | window |
|---|---|---:|---:|---:|
| 16 Pro Max | held mid-thread | 18–19 | 201 | 0 |
| 16 Pro Max | held in the growing run | 0 | 568 | 0 |
| SE | held mid-thread | 18 | 180 | 0.2 |
| SE | held in the growing run | 0.1 | 503 | 0.2 |

In the cap arm each move is a picture row leaving the top (128 pt on the SE, 149 pt on the 16 Pro Max) or a run's line
(about 60 pt), with the page's offset never moving, and 35 to 42% of the screen changes. The window arm's held screen
changed under 1.5%. The 18 pt move happens once, early in the mid-thread hold, in both of the arms without a window; it isn't
the cap, and it was not chased here.

## Evidence

`artifacts/ios-step-window/`: each phone's summary table from run 42125391747 (`large-summary.md`, `small-summary.md`), the
app's own report for round 1 of each arm (`<phone>-<arm>.json`, where `phases["working-mid"].page.heldMoves` lists every
frame the held row sat elsewhere), and the SE's screen at the window arm's end (`small-window-end.png`): the thread drawn at
its end, its newest pictures in place, while it works.

## What isn't covered

- A reader who presses Show earlier messages nine times in that thread, back to the cap's edge, holds the steps the cap drops
  again, and the page moves as before.
- #2246, a long thread of many turns moving by thousands of points after a send, is the lazy stack's guessed heights; a step
  window doesn't change those turns.
- The journey feeds the windowed detail to the app itself; the host's cut is covered by `tests/unit/shared/stepWindow.test.ts`
  and `tests/integration/socketThreadDetail.test.ts`. A real iPhone on a TestFlight build is the hand test.
