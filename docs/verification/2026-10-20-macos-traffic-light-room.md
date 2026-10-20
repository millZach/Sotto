# Watcher's header beside the macOS traffic lights, October 20, 2026

Pull request #1214 widened the room Sotto keeps for the macOS traffic lights to 88 pixels and made Watcher's header keep it in a narrow pane. Review found the header no longer fit there: with a thread beside Watcher, its pane can be 400 pixels wide (at the 820x560 minimum window, or with the divider at its end), and the Watched tab slid under Stop all and More Watcher actions.

Watcher's pane is always the room's left pane, so it always meets the window's corner and needs the room. On macOS the header now gives way 74 pixels sooner than elsewhere, which is how much more of it the lights take. Below 664 pixels, All threads and Stop all keep their icons and counts and the tabs tighten. Below 520 pixels, the tabs and the actions take a second row under the lights' row, starting at the pane's edge, and Watcher's name stays beside the tile. Focus still runs as the eye reads. The two-row header applies only once Watcher has started, when the tabs exist. Windows and Linux are unchanged.

## What was checked

On Windows, against Sotto Owl built from the branch, with the room's projection seeded through the end-to-end stand-in and the room given its macOS class (a Windows run has no traffic lights, so the class is what moves the header):

- `npx playwright test tests/e2e/watcher.spec.ts -g "in the macOS layout"`: in dark and light, with Visual gate flake open beside Watcher, at a 400-pixel Watcher pane in 1280x800 and in 820x560, and at 480, 559, 639 and 718 pixels in 1600x1000. No header control's box overlaps another's, each stays inside the header, no label or count is cut off, and nothing in the lights' row starts less than 84 pixels in. At 400 pixels the tile is at 88 to 112, Watcher's name at 122 to 178 and All threads at 188 to 255 in the first row; the tabs at 14 to 194 and Stop all and More Watcher actions at 333 to 394 in the second; the header is 90 pixels tall. The same run with the class off holds the Windows header to one 44-pixel row with the positions it had before this change ([readings](../../artifacts/macos-traffic-light-room/readings.json)).
- Before the change, the same run at 400 pixels on macOS put the tabs at 199 to 379, under Stop all at 333 and More Watcher actions at 364 ([before, dark 820x560](../../artifacts/macos-traffic-light-room/mac-header-before-dark-400px-820x560.png)).
- Captures draw the traffic lights in where macOS 26 puts them: [dark 820x560](../../artifacts/macos-traffic-light-room/mac-header-dark-400px-820x560.png), [light 820x560](../../artifacts/macos-traffic-light-room/mac-header-light-400px-820x560.png), [one tighter row at 559 pixels, dark](../../artifacts/macos-traffic-light-room/mac-header-dark-559px-1600x1000.png) and [the full row at 718 pixels, light](../../artifacts/macos-traffic-light-room/mac-header-light-718px-1600x1000.png).

## Not covered

- A real macOS window. The traffic lights in the captures are drawn by the test from their measured position, and the run is on Windows with the macOS class added.
- Off macOS, with Stop all showing, Watcher's header already overlaps at pane widths from about 470 to 575 pixels: the tabs run into Stop all, whose label and All threads' label both come back at those widths. Measured on this branch, whose rules for that header off macOS are `main`'s unchanged, so it is left for its own fix.
