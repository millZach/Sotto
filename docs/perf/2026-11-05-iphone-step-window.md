# What the iPhone is sent to open a long thread, before and with a step window - November 5, 2026

Zach asked why the iPhone loads a whole thread when the desktop opens a window of it. It doesn't quite: the phone has opened
the same newest ten turns as the desktop. But a thread of a few long turns is all inside ten turns. This note measures what
the phone was sent, and what it is sent with a **step window** (ADR-0194): the newest 200 steps, from the message before them.

## Bytes

Measured on a copy of forge's own thread store (`VACUUM INTO`), with the host's code: the ten-turn window
(`ThreadStore.readMessages`), its activity as `paneActivities` keeps it, then `detailWithoutVisuals`,
`detailWithActivitySummaries` and, after, `stepWindowStart` and `detailInStepWindow`. Sizes are the `detail` frame's JSON.
A phone's frames aren't compressed: the host deflates only for desktops.

| Thread | Before | After | Steps before → after | Pictures before → after |
|---|---:|---:|---:|---:|
| Design loop (c0179e09), 15 turns | 1,093 KB | 91 KB | 2,000 → 204 | 680 → 73 |
| bf1a67d6, one run of 1,242 steps | 1,078 KB | 153 KB | 1,489 → 210 | 9 → 0 |
| 70a9e0b4 | 435 KB | 204 KB | 436 → 210 | 0 |
| 6c5f4233 | 239 KB | 138 KB | 317 → 208 | 0 |
| e4e0fe35, 55 turns of a few steps | 267 KB | 236 KB | 255 → 210 | 0 |

Step counts include the turn records, which the window keeps. Cutting a detail takes the host 0.2 to 2 ms. Pictures are
fetched only as their tiles scroll near the screen, about 250 KB each, and aren't counted here.

## Open time, CPU and memory on the simulators

Scratch run [42125391747](https://github.com/millZach/Sotto/actions/runs/42125391747), on GitHub's `macos-26` with Xcode 26.6,
the Debug configuration built optimized as `Scripts/bench.sh` builds it. The picture journey (`--bench-journey pictures`)
opened the design loop thread's shape: its newest ten turns counted as message lengths, steps and pictures per run, none of
its words. `today` is that detail whole. `window` is the same thread as a host with a step window sends it. Two cold
launches per arm and phone; the time is from the open to its first drawn frame.

| Phone | Arm | Open | CPU to open | Peak memory |
|---|---|---:|---:|---:|
| 16 Pro Max | today | 5.4–9.7 s | 11.3–13.3 s | 386–390 MB |
| 16 Pro Max | window | 1.5–1.7 s | 2.0–2.2 s | 86–94 MB |
| SE (3rd generation) | today | 6.0–12.2 s | 12.7–12.9 s | 331–334 MB |
| SE (3rd generation) | window | 1.9–2.3 s | 3.0–3.1 s | 72–73 MB |

What the page does while the thread works is in [the verification note](../verification/2026-11-05-iphone-step-window.md).

## Repeating it

The byte table comes from a scratch test that opens a copy of the store with `ThreadStore` and runs the functions above; the
journey from branch `chore/ios-cap-jump-try` (`apps/ios/Scripts/try-cap.sh`, `--bench-pictures real`, `--bench-cap`,
`--bench-step-window`), kept until this change merges.
