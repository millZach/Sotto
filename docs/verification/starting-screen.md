# The starting screen at launch

October 15, 2026. Branch `feat/starting-screen`, from `88411663e` on `origin/main`. Records [ADR-0086](../adr/0086-the-window-opens-on-a-starting-screen-while-providers-and-hosts-connect.md), Zach's whole-window variant, checked in the built app on Windows 11.

## What was run

`tests/e2e/starting-screen.spec.ts` launches the built app with `SOTTO_E2E_STARTING_SCREEN=1`, the switch that lets an end-to-end run show the screen as an installed app does.

- **Providers connecting.** Codex and Devin are turned on in a seeded profile. Codex is the fixture provider and connects at once. Devin is the real adapter over the fake Devin agent, which holds its first `initialize` answer for eight seconds. The window opens on the screen: "Connecting Devin", with Codex's dot in the accent and Devin's breathing. The room has no button and no Threads sidebar behind it. When Devin answers, the Threads page takes the window. A reload of that window opens straight onto the Threads page, and an observer added before the reload never sees `.starting-screen` in the page.
- **A host that does not answer.** forge is saved and switched on. The scripted ssh signs in and then says nothing, so forge stays connecting. The screen reads "Connecting forge" and has no button. At ten seconds it reads "Waiting for forge", adds "forge has not answered in 10 seconds. Sotto keeps trying in the background." and **Open Sotto without forge**, which has keyboard focus. The strip keeps `-webkit-app-region: drag` and its window controls. A reload of the window, still starting, shows the screen again with the late line and its focused button back within seven seconds, rather than after another ten. `Enter` opens the Threads page, and the hosts state still reads forge as connecting.
- **A long host name.** The same silent host is saved under an 80-character name with no space or hyphen, the longest a saved host's name may be. At ten seconds the line, the name in the row, the late line and the button label each wrap inside the column. At every size and in both modes, no part of the column leaves it or runs past its own edges, and nothing scrolls. The same journey failed before the names could wrap, at 1600x1000 already: the line and the button left the column, and the late line's text ran past its edges.
- **An SSH question over the screen.** forge's scripted ssh asks for a password, and Devin holds its first answer for fourteen seconds. The question opens over the starting screen with focus in its field. At ten seconds **Open Sotto without Devin** appears and the field keeps focus, so `test-` typed then goes into the field. When Devin answers, the Threads page takes the window under the same question, with `test-` still in the field and focus still there. Typing the rest and `Enter` answers SSH, and the question closes.

All four passed (4 passed, 1.1 min). In two of the first five runs of the last journey the field did not have focus when the late button showed: once read with `toBeFocused`, which also needs the window in front, and once read from the page itself. It has not happened in the 18 runs since, eight of them sampling focus every 50 ms for 1.5 s after the button appeared, so the cause is not known. Four existing journeys passed: `crossing.spec.ts`, `workspace-picker.spec.ts`, `host-question-dismissal.spec.ts`, which answers saved hosts' SSH questions over the Threads page through the single dialog, and `window-thread-shell.spec.ts`. They do not set the switch and open onto the app as before. `window-thread-shell.spec.ts` fails now and then when it runs right after `crossing.spec.ts` (its thread envelope still lists a change). It did so once on `2128e54c3`, before the review fixes, too, and passed on its own and in two further runs after `crossing.spec.ts`.

## Fit and contrast

At 1600x1000, 1280x800 and 820x560, in dark and light, nothing scrolls, the column sits wholly inside the window, and the line, each name, the late line and its button sit inside the column without their text running past their edges, with forge and with the 80-character name. Text contrast on the late screen, measured in the running app against the surface behind it:

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
- `late-long-name-820x560-dark.png`: the 80-character host name late at the minimum size, wrapped in the line, the row, the late line and the button.

After the names were made to wrap, the nine earlier captures came out byte-identical, so the look at ordinary names did not change.

## Unit tests

`tests/unit/renderer/features/starting/startingView.test.ts` (10 tests) covers what holds the screen and what settles it, for providers and hosts, the line, the ten-second wording for one and several names, the wording when main has not given its first state at ten seconds, which holds the screen rather than settling it, and the dots. `tests/unit/renderer/features/starting/startingScreen.test.tsx` (12 tests) mounts the gate over the real agent provider with fake timers, with the saved hosts' SSH question beside it as the app seats it. It covers the fade, the one-step change with reduced motion, the late button's focus and description, an SSH question that keeps focus at ten seconds and hands it to the button when it closes, a launch with nothing to connect, the cached shell not counting as an answer with **Open Sotto now** at ten seconds, a reload while starting that keeps the same ten seconds, a reload after the app opened, first-run setup, settings still loading, the end-to-end switch, and a window with no agent bridge. `tests/unit/renderer/appStartingScreen.test.tsx` (1 test) mounts the whole app and keeps a half-typed SSH answer, and its focus, as the starting screen gives way to the Threads page. The two starting screen files build their agent state from `tests/fixtures/renderer/startingScreenState.ts`.

## Design gate

`node scripts/capture-design.mjs` on this machine fails the same three captures on this branch and on `88411663e`: `threads-open-running.png` (a taller user bubble), and `widget-idle-light.png` and `scale-125-onboarding.png` (one pixel taller). None is the starting screen, which no capture run shows. Each failure ends its spec's serial run, so four tests did not run on either commit, and `verify-design-captures.mjs` verified the 144 deterministic tuples on both. No baseline was regenerated. The review fixes were not run through the design gate again: they change only the starting screen and where the host question dialog is mounted, and no capture shows either.
