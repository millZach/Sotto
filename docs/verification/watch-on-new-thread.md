# Watch on a new thread, October 22, 2026

Watch among a new thread's chips (Zach's pick of design A, a pill after the permissions chip) checked in Sotto Owl built from `feat/watch-on-new-thread`, on an Apple silicon Mac, with `npm run build` and a throwaway Playwright run that launched the built app the way `tests/e2e/watcher.spec.ts` does: the Owl track through `onReleaseTrack('owl', …)`, main's own Watcher over the fake Codex app server (`SOTTO_E2E_NATIVE_FIXTURE_ROOT`), nothing seeded. A Codex thread made through main, in Ask for approval and never sent, stood for a new thread. Theme t3-code, dark and light. These captures are evidence for this note, not design baselines; the committed baselines are Windows captures.

## What was checked

- **Where it stands.** The chip row reads Fixture Codex, Low, Ask for approval, then **Watch** with the Watcher owl, styled as one of the composer's chips ([dark, 1280x800](../../artifacts/watch-on-new-thread/off-dark-1280x800.png), [light, 1280x800](../../artifacts/watch-on-new-thread/off-light-1280x800.png)). Its accessible name is Watch and `aria-pressed` carries the state. On a model with no permission modes (Sonnet 4.5 in the design scenario) there is no permissions chip, and Watch follows the model chip.
- **Pressed.** Pressed, the chip's hairline and its words and owl take the theme's accent; nothing else moves ([dark, 1280x800](../../artifacts/watch-on-new-thread/pressed-dark-1280x800.png), [light, 1280x800](../../artifacts/watch-on-new-thread/pressed-light-1280x800.png)). The border goes from a grey hairline to the accent border in both modes, and the words from muted to the accent text, so the two states read apart at a glance. Hover on the pressed chip keeps the accent and adds the chips' usual hover fill.
- **Keyboard.** Tab from the permissions chip reaches Watch, and Shift+Tab goes back. Space and Enter each press it, and `aria-pressed` follows. The focus ring is the app's 3px accent outline ([dark, 1280x800](../../artifacts/watch-on-new-thread/focused-dark-1280x800.png)). With an empty prompt Send is disabled, so Tab from Watch leaves the composer for the Threads switch.
- **Sizes.** At 1600x1000, 1280x800 and the 820x560 minimum, off and pressed, dark and light: `pageBoundProblems` finds nothing, the chip sits wholly inside its row and the window, and neither the chip nor its word is cut off. At 820x560 the row wraps and Watch moves to a second line under the model chip, still inside the composer ([dark off](../../artifacts/watch-on-new-thread/off-dark-820x560.png), [dark pressed](../../artifacts/watch-on-new-thread/pressed-dark-820x560.png), [light off](../../artifacts/watch-on-new-thread/off-light-820x560.png), [light pressed](../../artifacts/watch-on-new-thread/pressed-light-820x560.png)).
- **Contrast.** From the computed colours on the composer's surface ([readings](../../artifacts/watch-on-new-thread/readings.json)): off, 9.20:1 in dark and 6.95:1 in light; pressed, 12.13:1 and 7.58:1; pressed and hovered, measured against the hover fill alone, 7.60:1 and 6.22:1. All hold 4.5:1.

## Seen, not changed

The pane header has its own Watch toggle, with the same name and owl, and it stays unpressed while the chip is pressed: the chip shows a watch wanted from the first send, the header only a watch in force, and a press on each does a different thing. The two disagree on one screen until the first send. This is a question for the design, not the chip's stylesheet.

The room's other Watch toggles (`.watch-toggle`, `.watcher-row__watch`) mark pressed with an accent fill as well as the border. The chip marks it with border and text colour only, as the composer's other chips mark their states. Left as picked.

## Covered by tests

`tests/unit/renderer/watchOnSend.test.tsx`: the chip's place and name, its pressed state, the watch made once main accepts the first send or a Retry, a refused send keeping the chip pressed, and the chip absent where the Watcher gate is off, in Watcher's own composer and after the first send.

## Not covered

- Windows and Linux windows; the run was on macOS.
- Reduced motion: the chip adds no motion.
- Themes other than t3-code.
- A new thread that Watcher already watches, where the chip shows pressed before any press.
