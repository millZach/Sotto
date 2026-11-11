# The iPhone Duo design climb

November 10, 2026. Evidence for the Duo design climb (`docs/plans/2026-11-08-ios-duo-design-climb.md`): every change Zach picked over eight rounds, on the iPhone Duo's layout alone, folded and unfolded sideways. Every other iPhone is unchanged.

## How it was checked

- **The real app on the iPhone Duo simulator.** `apps/ios/Scripts/duo-captures.sh` runs `DuoCaptureTests` on GitHub's macOS runner (`.github/workflows/ios-duo-captures.yml`, on a push to a `duo-captures/<name>` branch). It takes a picture of each surface in dark, many in light too, and records each movement.
- **Before:** `duo-captures/climb-before` (run 42512061340), `main` at `235dd51b4` with only the capture lane added.
- **After:** `duo-captures/round-8-final` (run 42928343792), this branch's head, with `main` merged in and the review's fixes.
- **Judged:** each round, GPT-6.1 Sol, Claude Opus 5.5 and Claude Fable 5.2 scored that round's captures against T3 Code, Claude, ChatGPT with Codex and Cursor. The scores and Zach's picks are in the plan. Round 8, the last: Sol 9.5, Opus 9.2, Fable 8.5.
- **Each picture** has the before on the left and the after on the right. **Each video** plays the same movement before (left) and after (right), at 20 frames a second.

## What it doesn't show

- **Upright.** The simulator can't turn the unfolded Duo upright, so upright is checked in the prototypes and on Zach's Duo with the TestFlight build.
- **The keyboard.** The simulator's screenshot doesn't draw the software keyboard, so the keyboard pictures have a black lower part.
- **Six surfaces have no before**, since the capture lane added them during the climb: `folded-pictures-earlier-dark`, `folded-reply-keyboard-dark`, `folded-settings-further-dark`, `sideways-pictures-earlier-dark`, `sideways-settings-further-dark`, `sideways-settings-scrolled-dark`. They aren't in the lists below.
- **The black disc** at the top right of some folded pictures is the simulator's camera, not the app.

## Pictures and videos

### Pictures

Folded:

- [Folded, Agents, dark](../../artifacts/ios-duo-climb/shots/folded-agents-dark.jpg)
- [Folded, Computers, dark](../../artifacts/ios-duo-climb/shots/folded-computers-dark.jpg)
- [Folded, Computers, light](../../artifacts/ios-duo-climb/shots/folded-computers-light.jpg)
- [Folded, long thread, dark](../../artifacts/ios-duo-climb/shots/folded-long-thread-dark.jpg)
- [Folded, long thread, earlier, dark](../../artifacts/ios-duo-climb/shots/folded-long-thread-earlier-dark.jpg)
- [Folded, New thread, dark](../../artifacts/ios-duo-climb/shots/folded-new-thread-dark.jpg)
- [Folded, pictures, dark](../../artifacts/ios-duo-climb/shots/folded-pictures-dark.jpg)
- [Folded, pull request, checks, dark](../../artifacts/ios-duo-climb/shots/folded-pull-request-checks-dark.jpg)
- [Folded, pull request, dark](../../artifacts/ios-duo-climb/shots/folded-pull-request-dark.jpg)
- [Folded, question, dark](../../artifacts/ios-duo-climb/shots/folded-question-dark.jpg)
- [Folded, question, light](../../artifacts/ios-duo-climb/shots/folded-question-light.jpg)
- [Folded, question waiting, dark](../../artifacts/ios-duo-climb/shots/folded-question-waiting-dark.jpg)
- [Folded, reply box at rest, dark](../../artifacts/ios-duo-climb/shots/folded-reply-at-rest-dark.jpg)
- [Folded, Settings, dark](../../artifacts/ios-duo-climb/shots/folded-settings-dark.jpg)
- [Folded, Settings, light](../../artifacts/ios-duo-climb/shots/folded-settings-light.jpg)
- [Folded, Settings, scrolled, dark](../../artifacts/ios-duo-climb/shots/folded-settings-scrolled-dark.jpg)
- [Folded, thread, dark](../../artifacts/ios-duo-climb/shots/folded-thread-dark.jpg)
- [Folded, thread, earlier, dark](../../artifacts/ios-duo-climb/shots/folded-thread-earlier-dark.jpg)
- [Folded, thread, light](../../artifacts/ios-duo-climb/shots/folded-thread-light.jpg)
- [Folded, ••• card, dark](../../artifacts/ios-duo-climb/shots/folded-thread-menu-dark.jpg)
- [Folded, ••• card, pull request, dark](../../artifacts/ios-duo-climb/shots/folded-thread-menu-pull-request-dark.jpg)
- [Folded, thread, steps open, dark](../../artifacts/ios-duo-climb/shots/folded-thread-steps-open-dark.jpg)
- [Folded, Threads, dark](../../artifacts/ios-duo-climb/shots/folded-threads-dark.jpg)
- [Folded, Threads, light](../../artifacts/ios-duo-climb/shots/folded-threads-light.jpg)
- [Folded, Threads, scrolled, dark](../../artifacts/ios-duo-climb/shots/folded-threads-scrolled-dark.jpg)
- [Folded, Watcher, dark](../../artifacts/ios-duo-climb/shots/folded-watcher-dark.jpg)
- [Folded, Watcher, keyboard, dark](../../artifacts/ios-duo-climb/shots/folded-watcher-keyboard-dark.jpg)
- [Folded, Watcher, light](../../artifacts/ios-duo-climb/shots/folded-watcher-light.jpg)

Sideways:

- [Sideways, Agents, dark](../../artifacts/ios-duo-climb/shots/sideways-agents-dark.jpg)
- [Sideways, Computers, dark](../../artifacts/ios-duo-climb/shots/sideways-computers-dark.jpg)
- [Sideways, Computers, light](../../artifacts/ios-duo-climb/shots/sideways-computers-light.jpg)
- [Sideways, long thread, dark](../../artifacts/ios-duo-climb/shots/sideways-long-thread-dark.jpg)
- [Sideways, long thread, earlier, dark](../../artifacts/ios-duo-climb/shots/sideways-long-thread-earlier-dark.jpg)
- [Sideways, Needs you, dark](../../artifacts/ios-duo-climb/shots/sideways-needs-you-dark.jpg)
- [Sideways, Needs you, light](../../artifacts/ios-duo-climb/shots/sideways-needs-you-light.jpg)
- [Sideways, New thread, dark](../../artifacts/ios-duo-climb/shots/sideways-new-thread-dark.jpg)
- [Sideways, pictures, dark](../../artifacts/ios-duo-climb/shots/sideways-pictures-dark.jpg)
- [Sideways, pull request, checks, dark](../../artifacts/ios-duo-climb/shots/sideways-pull-request-checks-dark.jpg)
- [Sideways, pull request, dark](../../artifacts/ios-duo-climb/shots/sideways-pull-request-dark.jpg)
- [Sideways, question, dark](../../artifacts/ios-duo-climb/shots/sideways-question-dark.jpg)
- [Sideways, question, light](../../artifacts/ios-duo-climb/shots/sideways-question-light.jpg)
- [Sideways, question waiting, dark](../../artifacts/ios-duo-climb/shots/sideways-question-waiting-dark.jpg)
- [Sideways, reply box at rest, dark](../../artifacts/ios-duo-climb/shots/sideways-reply-at-rest-dark.jpg)
- [Sideways, reply box with the keyboard, dark](../../artifacts/ios-duo-climb/shots/sideways-reply-keyboard-dark.jpg)
- [Sideways, Settings, dark](../../artifacts/ios-duo-climb/shots/sideways-settings-dark.jpg)
- [Sideways, Settings, light](../../artifacts/ios-duo-climb/shots/sideways-settings-light.jpg)
- [Sideways, thread, dark](../../artifacts/ios-duo-climb/shots/sideways-thread-dark.jpg)
- [Sideways, thread, earlier, dark](../../artifacts/ios-duo-climb/shots/sideways-thread-earlier-dark.jpg)
- [Sideways, thread, idle, dark](../../artifacts/ios-duo-climb/shots/sideways-thread-idle-dark.jpg)
- [Sideways, thread, light](../../artifacts/ios-duo-climb/shots/sideways-thread-light.jpg)
- [Sideways, ••• card, dark](../../artifacts/ios-duo-climb/shots/sideways-thread-menu-dark.jpg)
- [Sideways, ••• card, pull request, dark](../../artifacts/ios-duo-climb/shots/sideways-thread-menu-pull-request-dark.jpg)
- [Sideways, thread, sidebar hidden, dark](../../artifacts/ios-duo-climb/shots/sideways-thread-sidebar-hidden-dark.jpg)
- [Sideways, thread, steps open, dark](../../artifacts/ios-duo-climb/shots/sideways-thread-steps-open-dark.jpg)
- [Sideways, Threads, dark](../../artifacts/ios-duo-climb/shots/sideways-threads-dark.jpg)
- [Sideways, Threads, light](../../artifacts/ios-duo-climb/shots/sideways-threads-light.jpg)
- [Sideways, Threads, scrolled, dark](../../artifacts/ios-duo-climb/shots/sideways-threads-scrolled-dark.jpg)
- [Sideways, Watcher, dark](../../artifacts/ios-duo-climb/shots/sideways-watcher-dark.jpg)
- [Sideways, Watcher, keyboard, dark](../../artifacts/ios-duo-climb/shots/sideways-watcher-keyboard-dark.jpg)
- [Sideways, Watcher, light](../../artifacts/ios-duo-climb/shots/sideways-watcher-light.jpg)

### Videos

- [Folded, back to Threads, dark](../../artifacts/ios-duo-climb/clips/folded-back-to-threads-dark.mp4)
- [Folded, scroll a long thread, dark](../../artifacts/ios-duo-climb/clips/folded-long-thread-scroll-dark.mp4)
- [Folded, open a thread, dark](../../artifacts/ios-duo-climb/clips/folded-open-thread-dark.mp4)
- [Folded, a question opens, dark](../../artifacts/ios-duo-climb/clips/folded-question-open-dark.mp4)
- [Folded, a question opens, light](../../artifacts/ios-duo-climb/clips/folded-question-open-light.mp4)
- [Folded, the reply box takes focus, dark](../../artifacts/ios-duo-climb/clips/folded-reply-focus-dark.mp4)
- [Folded, tab change, dark](../../artifacts/ios-duo-climb/clips/folded-tab-change-dark.mp4)
- [Sideways, back to Threads, dark](../../artifacts/ios-duo-climb/clips/sideways-back-to-threads-dark.mp4)
- [Sideways, scroll a long thread, dark](../../artifacts/ios-duo-climb/clips/sideways-long-thread-scroll-dark.mp4)
- [Sideways, open a thread, dark](../../artifacts/ios-duo-climb/clips/sideways-open-thread-dark.mp4)
- [Sideways, a question opens, dark](../../artifacts/ios-duo-climb/clips/sideways-question-open-dark.mp4)
- [Sideways, a question opens, light](../../artifacts/ios-duo-climb/clips/sideways-question-open-light.mp4)
- [Sideways, the reply box takes focus, dark](../../artifacts/ios-duo-climb/clips/sideways-reply-focus-dark.mp4)
- [Sideways, hide the sidebar, dark](../../artifacts/ios-duo-climb/clips/sideways-sidebar-hide-dark.mp4)
- [Sideways, show the sidebar, dark](../../artifacts/ios-duo-climb/clips/sideways-sidebar-show-dark.mp4)
- [Sideways, switch thread from the sidebar, dark](../../artifacts/ios-duo-climb/clips/sideways-sidebar-switch-thread-dark.mp4)
- [Sideways, tab change, dark](../../artifacts/ios-duo-climb/clips/sideways-tab-change-dark.mp4)
