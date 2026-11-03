# iPhone small reply box verification

November 2, 2026, on `feat/iphone-small-reply-box`, with #2039's composer padding and Duo layout merged in. This is ADR-0184, from the user's picks on `docs/prototypes/iphone-small-reply-box-prototype.html`. This machine can't build iOS, so everything below comes from a throwaway capture branch on GitHub's macOS runners: run 41580149147, head f092e69e7. The Duo ran on iOS 27.1 and the iPhone 17 Pro on iOS 26.5, because iOS 27.1's simulator only takes the Duo. The app ran on the Debug-only `--ui-fixture` host.

All six capture tests passed in each of five passes: iPhone, iPhone with Reduce Motion, Duo folded, and Duo unfolded sideways and upright. Each also recorded the box moving eight times, four each way. The picture of the full box at top effort didn't save on the folded Duo; its position is logged and the same state saved everywhere else.

The pictures are in `artifacts/iphone-small-reply-box/`.

## What the pictures show

1. **A thread with content opens small.** One row of the +, the prompt, the mic and Send, with no model pill (`iphone-small.png`, `duo-folded-small.png`, `duo-unfolded-small.png`). The prompt sits level with the + and stops short of the mic.
2. **Tapping in brings it back full.** The caret and keyboard arrive and the pill is back (`iphone-full-keyboard.png`, `duo-folded-full-keyboard.png`, `duo-unfolded-full-keyboard.png`).
3. **A running thread shows the white round Stop in the small row** (`iphone-small-running-stop.png`, `duo-unfolded-small-running-stop.png`).
4. **What keeps it full.** A new empty thread (`iphone-new-thread-full.png`) and a draft with the keyboard away (`iphone-draft-full.png`). A tap on the conversation with an empty box put the keyboard away and the box went small again, by position in every pass.
5. **No border or outline in any state.** At the top effort the slow light follows the small shape in dark and light (`iphone-dark-top-effort.png`, `iphone-light-top-effort.png`).
6. **Watcher's box follows the same rule** (`iphone-watcher-small.png`).
7. **Reduce Motion.** The small box looks the same (`iphone-reduced-small.png`), and the recording goes from small to full between one frame and the next.

## What the logged positions show

The + and the row's foot hold still between the two shapes: on the iPhone the + stays at y 790 from a new thread to small to a draft. The box's width doesn't change between shapes either. On the unfolded Duo the mic sits at x 760 in some launches and 764 in others, but it is the same in both shapes within a launch.

## The motion

The recordings first found two flaws, on run 41557241965. Going full, the top edge and words jumped in about one frame. Going small, they followed the keyboard's fast-starting curve, so the words crossed the fading pill for about two frames. The box's shape now has its own animation, and run 41580149147 shows both gone on the folded Duo, the unfolded Duo and the iPhone:

- **Going full** (`motion-going-full.png`, read left to right): the keyboard rises with the box still small, then the words and the top edge move up over several frames, then the pill fades in.
- **Going small** (`motion-going-small.png`): the pill fades while the words wait, and the words reach the row once it has gone.

These tiles are from the folded Duo, every frame from the recording. A simulator recording on a shared runner can't say how a real phone feels: going full starts about 0.2 seconds after the keyboard starts to rise there. No real phone has run this.

## Not shown here

- **VoiceOver.** The simulator can't run it. The pill is `accessibilityHidden` while small, but XCUITest still finds it, so hiding it from VoiceOver rests on SwiftUI's documented behaviour.
- **Cost of the moves.** The `reply-box` and `reply-box-stream` benchmark phases hold this; the numbers come from the pull request's `ios-perf` run.
