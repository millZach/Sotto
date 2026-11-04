# iPhone Duo thread rail, no bar and no title verification

November 3, 2026, on `fix/duo-thread-rail-no-title-bar`. This is ADR-0151's November 3 amendment, Zach's picks from the prototype at the tag `prototype/iphone-duo-no-title-bar`. Captures were taken on the iPhone Duo simulator (iOS 27.1, Xcode 27.1) on GitHub's `xcode-27` runner, with the Debug-only `--ui-fixture`, `--ui-still` and `--ui-watcher`, the fold moved by the posture tool from the tag `prototype/iphone-duo-layout`, on a throwaway capture branch. The final run is 41714296570. The baseline of `main` is job "main" of run 41694804120, which held the same test against the app at the branch's merge base.

## What the captures show

All in `artifacts/iphone-duo-thread-rail/`.

1. **Folded, a thread** (`folded-thread.jpg`): Back stands under the clock and battery, and low in the strip the state, the owl and ••• stand in one pill of same-size tiles. No bar and no title stand over the page.
2. **Folded, light, with Agents** (`folded-agents-light.jpg`): the robot tile joins the pill, with its count in the warning colour while a delegated thread waits on the user. The pill grows from 164 to 216 points and stays low.
3. **Folded, the ••• menu** (`folded-menu.jpg`): the name, then where it runs, the branch, the changes and the pull request stand at the top, wrapped rather than cut off, with Settle under them.
4. **Folded, a delegated thread** (`folded-nested-light.jpg`): opened from Agents, with the question's sheet set aside. Back goes to the thread it came from: the log shows the Agents pill again at 216 points and the first thread's scroll position.
5. **Sideways, a thread** (`sideways-thread.jpg`, light with Agents in `sideways-agents-light.jpg`): the state with its time, the owl and ••• stand in a pill over the tabs, the sidebar's button under the clock, and + in the sidebar's heading. With Agents the two pills fit, 8 points below the sidebar's button.
6. **Sideways, the ••• menu** (`sideways-menu.jpg`): as folded, opening over the rail.
7. **Sideways, a delegated thread** (`sideways-nested-light.jpg`): Back takes the sidebar button's place, at the same 124 points. Pressing it brought the sidebar button back.
8. **Upright, drawn** (`upright-drawn-thread.jpg`): Back, the sidebar's button and New thread at the top of the rail, then the thread's pill over the tabs. See the limit below.

## The keyboard

The rail once rose past the clock with the keyboard up, because its height had a lower limit of its own contents. `main` had this in a smaller form; the taller pill made it worse, so this change fixes it. The rail's frame now has no lower limit. `DuoJourneyTests` checks it sideways.

| Top of the rail, keyboard up | No keyboard | `main` | Before the fix | Now |
| --- | --- | --- | --- | --- |
| Folded, Back | 176 | 176 | 155 | 176 |
| Sideways, the sidebar's button | 124 | 91 | 49 | 124 |

`sideways-keyboard-main.jpg` shows `main`'s button half behind the battery and `sideways-keyboard.jpg` shows it now. The folded row comes from the test's frames, since the host's picture of it landed on the home screen just after the test closed the app.

## Journeys

`DuoJourneyTests.testSidewaysRailAndSidebarDrag` passed on the Duo. Its two upright tests skipped, as the limit below explains, so their new assertions have not run. CI's iPhones skip all three.

## Limits

- **The menu's heading is below 4.5:1.** iOS draws it in its own grey and an app can't recolour it. Measured on `folded-menu.jpg`'s source picture, the name is 3.29:1 and the rest 3.62:1, against 11.97:1 for Settle. As a disabled row they were 2.30:1 and 3.34:1. Zach chose iOS's menu over drawing a popover of our own.
- **Upright is drawn, not turned.** All four orientations left the window at 951×669, as in `2026-10-30-iphone-duo-tab-rails.md`. The picture forces the upright layout inside the sideways window with a flag that exists only on the capture branch, so it shows how the rail draws, not the upright window's real size. In that 669-point window the rail starts 12 points down rather than 16, since it needs slightly more height than the window has.
- **Not seen:** a real Duo, VoiceOver, the accessibility text sizes, reduced motion, the menu in light mode, and the menu's pull request row. The fixture's computer doesn't offer the pull request sheet, so the pull request reads with the rest of the heading in the pictures, and the row was checked by compiling only.
