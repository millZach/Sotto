# Tools rail verification

The Tools panel rebuilt around direction A, "the rail", which the owner picked in #235. `docs/plans/2026-09-22-tools-rail.md` records the pick, the mock-up it came from and the decisions the pick left open. This supersedes `docs/verification/tools-sidecar.md`.

## What the panel is now

- **The rail.** A 58-pixel strip on the panel's outer edge. Its tiles start under the window's own controls: Browser, Terminal, Files, Changes and Agents, each an icon over a short word. The open surface sits on a raised tile (the sidebar's selected tone) with a 2-pixel accent mark on its outer side; in forced colours it takes a system outline instead. A small accent dot marks a surface that is not open and has something live: a browser task working or waiting for an answer, changed files, or agents working. The surface's description in the rail says which in words ("2 agents are working", "3 changed files"), on the open surface too. Pin, expand and close sit at the rail's foot under a short rule; a pressed Pin or Restore takes the tiles' selected tone.
- **The Changes dot.** Changes reads Git only while it is open. Away from it, the dot follows the working copy's dirty mark, which main reads after each turn. On Changes, and for a thread with no working-copy record, it follows the last count Changes read, with a `+` when Git reported more files than Sotto lists.
- **One line of chrome per surface**, 44 pixels high so it meets the pane header on one hairline, with a 20-pixel gap before the window's controls. It names what is open (the page tabs, the shell tabs, the folder, the change count and branch, or the agent count and how many are working) and holds that surface's own actions on the right. A fact beside a title, such as the branch on Changes, shows as a readable run of at least six characters or not at all.
- **Actions on the line.** The open page or shell carries its own close, the way a tab closes, so the line's end holds only New page or New terminal (and Send Ctrl+C, a stop circle, while a command runs). Browser's Comment on page and Share with agent sit on its tab line; Changes' Git actions, Checkpoints and Pull request sit on its line. Below 640 pixels of content these show only their icons and keep their names as accessible names and tooltips.
- **Second rows.** The browser's address is a second, slimmer row, and the viewport size ends it. There is no review row. On Changes, Stage file sits in the open file's head, and the Git drawers open under the line only when asked for. The open file's head holds its size, Read only, and Wrap lines as an icon toggle.
- **The working copy is the footer**: the project, then the branch in mono when it is known (the thread's recorded branch, or the branch Changes last read for a project folder), then the kind of folder, then Copy path and Show in File Explorer for the working folder. A pinned panel adds the thread's name and a Pinned tag, set apart by a rule.
- **List and detail.** Files and Changes stack the list above the detail until the panel's content area (the panel minus the rail) is 640 pixels wide, so code keeps the whole width. From there they sit side by side, with the list taking a share of the width, so expanding the panel widens the code. Beside the diff a changed file is two lines: its name, then its folder and staging.
- **The corner browser preview** stands 16 pixels inside the rail while Tools is open, instead of over its lower tiles.
- **Keyboard order.** Opening lands on the open tile. The arrow keys move along the rail; Tab goes from the rail to its foot (pin, expand, close), then into the surface's line of chrome, its work and the footer. #235 asks for "rail, then chrome, then content", and the foot is part of the rail. The rail is drawn on the right but read first, the way a tab list comes before its panel.

## Method

`tests/e2e/tools-sidecar.spec.ts` launches the built app in Electron with fixture coding providers and a disposable profile. The file keeps the Sidecar's name so `docs/ci.md` and the other records that cite it stay right. The browser, PTY, files and Git are the production implementations. It sets up a real local page, a real shell, a small Git repository with three changed files (four once the shell writes its proof file), and three reported subagents (two working).

```powershell
npm run build
npx playwright test tests/e2e/tools-sidecar.spec.ts --workers=1
```

For every window size (1600 × 1000, 1280 × 800, 820 × 560), every panel width (normal, the resize step nearest the app's own default of 56% of the workspace; minimum, 380 pixels; wide, 788 pixels), dark and light, and every surface, the spec asserts:

- no horizontal overflow in the document or the panel, and the sheet inside the window;
- nothing in a surface's line of chrome sits under the window controls, and the rail's tiles start below them;
- the rail's foot is inside the window, no rail word is cut short, and no rail or footer button is clipped;
- the line of chrome is one line (44 pixels), no fact beside its title is cut to a stub, and no control on the line or in a file's head is clipped;
- Files and Changes are stacked below 640 pixels of content and side by side from 640;
- text contrast is at least 4.5:1, painted over every background between the text and the sheet, for the rail's words, the line of chrome's title and fact, its page and shell tabs and its worded actions, and the footer's working copy, branch and folder;
- the native page's bounds match the viewport exactly for Browser, and no native view is shown on any other surface;
- the shell keeps its output across every switch.

That is 90 captures. After the matrix it checks the split diff; pin, with the pinned footer (the thread's name and its Pinned tag) held to the same 4.5:1 in dark and light; unpin; expand and restore at 1280 and 820; the resize handle's keyboard steps; Escape closing a wide overlay panel with focus back on the Tools button; close and reopen with the project sidebar coming back at 820; and reduced motion on every surface. Last, an agent asks to open a page while Tools shows Files: at 1280 × 800 and 820 × 560 the corner preview shows the waiting request, the Browser surface's description says so, and the preview covers no rail tile or foot button.

The unit tests cover the dot's rules (hidden on the open surface, the dirty mark winning away from Changes, the `+` of a cut-off list), the Git toggles on the Changes line and Stage file in the file head, and the footer's branch.

## Results

Passed on Windows 11 on 2026-09-22: **1 passed**, about 55 seconds per run.

- Normal width is 716 pixels at 1600 (content 657, side by side), 548 at 1280 and 452 at 820 (both stacked). Minimum is stacked everywhere. Wide is docked at 1600 and overlays the panes at 1280 and 820 (788 and 772 pixels, content 729 and 713), side by side in both. `artifacts/tools-rail/layout.json` records every capture's measurements and mode.
- At the minimum panel (321 pixels of content) the Changes line reads "4 changed files" with its four actions as icons; the branch gives way whole and the footer still names it. At 1280 normal (489 pixels) the line reads "4 changed files master".
- The words in the rail are 12 pixels, the app's floor, a touch above the mock-up's 10.5. "Changes" and "Terminal" fit the 50-pixel tile.
- With reduced motion on, the sheet arrives with `animation-name: none`, and nothing on any surface runs longer than the 1-millisecond floor the setting leaves.
- No renderer errors.

## Images

In `artifacts/tools-rail/`, one per state the note names:

- `browser-1600x1000-normal-dark.png`, `browser-1600x1000-normal-light.png`: the page tab with its close, Comment on page and Share with agent in words on the tab line, the address row ending in the viewport size, the page at full height.
- `browser-820x560-minimum-light.png`: the tightest browser; the review actions as icons on the tab line and no review row.
- `files-1280x800-normal-dark.png`: tree above the open file; the file's own line holds its size, Read only and the Wrap lines icon beside its other actions.
- `files-1600x1000-wide-light.png`, `changes-1280x800-wide-dark.png`: side by side on a wide panel (the second is an overlay, its change rows two lines each).
- `files-820x560-minimum-dark.png`, `changes-820x560-minimum-light.png`: stacked at the minimum; the change count keeps its words, the branch gives way whole, and Stage file sits in the file's head.
- `terminal-820x560-minimum-dark.png`, `terminal-1280x800-normal-light.png`: shell tabs as the line of chrome, close on the open shell, Send Ctrl+C as a stop circle, and the gap before the window's controls.
- `agents-1280x800-normal-dark.png`, `agents-820x560-wide-light.png`: the count and "2 working" on the line of chrome, and no dot on the open Agents tile.
- `browser-pinned-1280-dark.png`: Pin pressed at the rail's foot in the tiles' selected tone, and the footer naming the branch and the pinned thread.
- `browser-expanded-1280-dark.png`: expanded to fill the workspace, rail still on the outer edge.
- `changes-split-1280-dark.png`: the split diff.
- `corner-preview-files-820x560-dark.png`: a waiting browser request's corner preview standing inside the rail while Tools shows Files, with the dot on Browser.
- `agents-reduced-motion-1280-dark.png`: the panel after reopening with reduced motion on.

The spec writes all 97 captures to `artifacts/tools-rail-run/`, which is ignored.

## Other specs

The specs that open Tools were run against this branch; the pull request lists their counts. `npm run design:verify` passes: 144 capture tuples, with `threads-files-unavailable-dark` and `-light` (the only design captures with Tools open) recaptured for the wider gap before the window's controls.

## Practical limits

This is Windows with fixture providers, a local page and owned working files. It does not cover macOS, where the window controls sit beside the sidebar and the rail's empty top is only a margin, or a live provider account. Forced colours were reasoned from the stylesheet, not captured.

At the minimum panel the address field shows about ten characters beside the history buttons, the system-browser button and the viewport size; it selects the whole address on focus. Away from Changes, a change the user makes in the terminal lights the Changes dot only after the thread's next turn, when main reads the working copy again.
