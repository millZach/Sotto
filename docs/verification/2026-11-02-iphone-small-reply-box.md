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
- **Cost of the moves.** Run 41597641875 measured `main` and this change on one runner, at 9eea27d16. Twenty moves of the box drew no conversation, no messages and no text views (`reply-box`: 0, 0 and 0, with 40 draws of the reply dock). The numbers that `main` also has came out no worse, and the better ones aren't a gain: launch, which this change doesn't touch, came out 1.48 times faster too, so the runner was slower while it measured `main`.

  | | `main` | This change | Unit |
  | --- | ---: | ---: | --- |
  | Opening a thread, press to drawn | 3,318 | 2,873 | ms |
  | Opening a thread, CPU | 4,547 | 4,080 | ms |
  | Streaming, CPU for each chunk | 86.64 | 68.31 | ms |
  | Streaming, hitches | 95 | 61 | count |
  | Streaming, longest frame | 441 | 387 | ms |

  Moving the box while a reply streams does cost something. In one run of this change, `stream` took 68.31 ms of CPU for each chunk and `reply-box-stream` took 82.79 ms, with 61 and 108 hitches and longest frames of 387 and 419 ms. That phase moves the box 29 times in 200 chunks, far more often than anyone would. What each chunk draws stays the same but for the reply dock itself, 0.49 draws against 0.20. Opening a thread drew `MessageView` 26 to 47 times on `main` and 27 to 73 on this change over five runs each: the ranges overlap, and the 73 is one run.
