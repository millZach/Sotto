# Show earlier messages shows what it brings on the iPhone - November 12, 2026

Zach: "when I go to load earlier messages on the iOS app it doesnt work or it takes an extremley long time".

## What the host sends

`scripts/perf-bench/earlier-steps-probe.mjs` pairs a throwaway phone with the host on forge, sends the iPhone's own hello and
presses Show earlier messages (`earlier-steps`) until nothing is above the window. On the Godot ARPG thread (5a4f24ec: 220
messages, 2,000 steps):

| Read | Host time | Size | Revision | Messages | Steps | Steps above |
|---|---:|---:|---:|---:|---:|---:|
| Open | 10 ms | 118 KB | 997 | 9 | 200 | 1,797 |
| Press 1 | 14 ms | 235 KB | 997 | 11 | 400 | 1,597 |
| Press 4 | 25 ms | 493 KB | 997 | 16 | 1,000 | 997 |
| Press 8 | 26 ms | 907 KB | 997 | 35 | 1,800 | 197 |
| Press 9 | 35 ms | 1,201 KB | 997 | 218 | 1,997 | 0 |

The design loop thread (c0179e09) and a thread of 1,119 messages with no steps (c05dfe49) answered every press in 14 to 127 ms.
The host never failed or stalled. Every answer came at the revision the phone already held, as ADR-0194 says it does.

## Why the iPhone showed nothing

The phone takes that answer in place of its copy. The thread page made its rows once per revision (`TimelineCache` in
`ThreadViews.swift`, keyed on the thread and its revision since October), so at the same revision it handed back the rows it
had. The count under the button went down by 200, or the button went once the whole thread was there, and no earlier message
showed until the thread next changed. On a quiet thread that is never; on a working one it is the next update.

The page now keys its rows on the model's count of copies taken in as well.

## The journey

`FocusJourneyTests.testShowEarlierMessagesShowsWhatItBrings` opens the long fixture thread (40 turns) on a step window of its
newest ten (`--ui-step-window`), presses Show earlier messages, and waits for any of the first thirty questions. The fixture
answers the press as a host does: the whole thread, at the same revision.

Scratch run [43366214072](https://github.com/millZach/Sotto/actions/runs/43366214072), iPhone 16 Pro Max simulator, Xcode 26.6:

| Arm | Run 1 | Run 2 |
|---|---|---|
| This change | passed, shown 4.1 s after the press | passed, shown 2.8 s after the press |
| Main's `ThreadViews.swift` | failed, nothing shown 23.4 s after the press | failed, nothing shown 22.8 s after the press |

The times include XCUITest reading the page and the fixture's 0.3 s answer, so they say "shown", not how fast.

On main, after the press, the page starts at question 31 with no button above it
([main-after-press.jpg](../../artifacts/ios-show-earlier/main-after-press.jpg)). With the change it starts at question 1
([fix-after-press.jpg](../../artifacts/ios-show-earlier/fix-after-press.jpg)). Both pictures are from the first scratch run,
[43344629093](https://github.com/millZach/Sotto/actions/runs/43344629093), whose journey read the page after the press in a
way that failed on both arms. The page was the same.

## Not checked here

- The laptop's host. Model Sentiment Index (6a27526e) is on the laptop, and pairing a probe there writes an answer grant.
  The cause above is on the phone, whichever computer answers.
- A real iPhone. That rides the next TestFlight build.
- After the press the page shows the new messages from the oldest, at the top where the reader pressed, as an iPhone whose
  computer has no step window always has. Keeping the reader's place, as the desktop does since #2369, isn't done here.
- Each press sends the whole window again, up to 1.2 MB before compression on the Godot thread, and the phone lays it out
  again. Not measured on the phone here.
