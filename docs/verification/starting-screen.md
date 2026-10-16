# The starting screen at launch

October 15, 2026. Branch `feat/starting-screen`, from `88411663e` on `origin/main`. Records [ADR-0086](../adr/0086-the-window-opens-on-a-starting-screen-while-providers-and-hosts-connect.md), Zach's whole-window variant, checked in the built app on Windows 11.

## What was run

`tests/e2e/starting-screen.spec.ts` launches the built app with `SOTTO_E2E_STARTING_SCREEN=1`, the switch that lets an end-to-end run show the screen as an installed app does.

- **Providers connecting.** Codex and Devin are turned on in a seeded profile. Codex is the fixture provider and connects at once. Devin is the real adapter over the fake Devin agent, which holds its first `initialize` answer for eight seconds. The window opens on the screen: "Connecting Devin", with Codex's dot in the accent and Devin's breathing. The room has no button and no Threads sidebar behind it. When Devin answers, the Threads page takes the window. A reload of that window opens straight onto the Threads page, and an observer added before the reload never sees `.starting-screen` in the page.
- **A host that does not answer.** forge is saved and switched on. The scripted ssh signs in and then says nothing, so forge stays connecting. The screen reads "Connecting forge" and has no button. At ten seconds it reads "Waiting for forge", adds "forge has not answered in 10 seconds. Sotto keeps trying in the background." and **Open Sotto without forge**, which has keyboard focus. The strip keeps `-webkit-app-region: drag` and its window controls. `Enter` opens the Threads page, and the hosts state still reads forge as connecting.

Both passed (2 passed, 26.0 s). Three existing journeys that open on Threads right after launch, `crossing.spec.ts`, `window-thread-shell.spec.ts` and `workspace-picker.spec.ts`, passed (3 passed, 28.9 s); they do not set the switch and open onto the app as before.

## Fit and contrast

At 1600x1000, 1280x800 and 820x560, in dark and light, nothing scrolls and the column sits wholly inside the window. Text contrast on the late screen, measured in the running app against the surface behind it:

| Text | Dark | Light |
| --- | --- | --- |
| The line, "Waiting for forge" | 19.55:1 | 15.74:1 |
| A name in the row, "forge" | 9.48:1 | 6.72:1 |
| The late line | 13.59:1 | 10.44:1 |
| The button | 13.59:1 | 10.44:1 |

The figures are the same at all three sizes.

## Captures

In `artifacts/starting-screen/`:

- `providers-1280x800-dark.png`: Codex ready, Devin connecting.
- `connecting-1280x800-dark.png`, `connecting-1280x800-light.png`, `connecting-820x560-dark.png`, `connecting-820x560-light.png`: forge connecting, before ten seconds.
- `late-1280x800-dark.png`, `late-1280x800-light.png`, `late-820x560-dark.png`, `late-820x560-light.png`: forge late, with the button focused.

## Unit tests

`tests/unit/renderer/features/starting/startingView.test.ts` (10 tests) covers what holds the screen and what settles it, for providers and hosts, the line, the ten-second wording for one and several names, and the dots. `tests/unit/renderer/features/starting/startingScreen.test.tsx` (10 tests) mounts the gate over the real agent provider with fake timers. It covers the fade, the one-step change with reduced motion, the late button's focus and description, a launch with nothing to connect, the cached shell not counting as an answer, a reload, first-run setup, settings still loading, the end-to-end switch, and a window with no agent bridge.

## Design gate

`node scripts/capture-design.mjs` on this machine fails the same three captures on this branch and on `88411663e`: `threads-open-running.png` (a taller user bubble), and `widget-idle-light.png` and `scale-125-onboarding.png` (one pixel taller). None is the starting screen, which no capture run shows. Each failure ends its spec's serial run, so four tests did not run on either commit, and `verify-design-captures.mjs` verified the 144 deterministic tuples on both. No baseline was regenerated.
