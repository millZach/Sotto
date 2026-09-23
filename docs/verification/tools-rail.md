# Tools rail verification

The Tools panel rebuilt around direction A, "the rail", which the owner picked in #235 from the mock-up on `prototype/tools-panel` (`docs/prototypes/tools-panel-prototype.html`, variant A). This supersedes `docs/verification/tools-sidecar.md`.

## What the panel is now

- **The rail.** A 58-pixel strip on the panel's outer edge. Its tiles start under the window's own controls: Browser, Terminal, Files, Changes and Agents, each an icon over a short word. The open surface sits on a raised tile (the sidebar's selected tone) with a 2-pixel accent mark on its outer side. A small accent dot marks a surface with something live: a browser task working or waiting for an answer, changed files, or agents working. The tab's description says which in words ("2 agents are working", "3 changed files"). Pin, expand and close sit at the rail's foot under a short rule.
- **One line of chrome per surface**, 44 pixels high so it meets the pane header on one hairline. It names what is open: the page tabs, the shell tabs, the folder, the change count and branch, or the agent count and how many are working. The surface's own actions sit on the right. The browser's address is a second, slimmer row beneath it, as before.
- **The working copy is the footer**: project, then branch or folder, then Copy path and Show in File Explorer for the working folder. A pinned panel adds the thread's name and a Pinned tag, set apart by a rule.
- **List and detail.** Files and Changes stack the list above the detail until the panel's content area (the panel minus the rail) is 640 pixels wide, so code keeps the whole width. From there they sit side by side, with the list taking a share of the width, so expanding the panel widens the code.

## Method

`tests/e2e/tools-sidecar.spec.ts` launches the built app in Electron with fixture coding providers and a disposable profile. The browser, PTY, files and Git are the production implementations. It sets up a real local page, a real shell, a small Git repository with three changed files (four once the shell writes its proof file), and three reported subagents (two working).

```powershell
npm run build
npx playwright test tests/e2e/tools-sidecar.spec.ts --workers=1
```

For every window size (1600 × 1000, 1280 × 800, 820 × 560), every panel width (normal, the resize step nearest the app's own default of 56% of the workspace; minimum, 380 pixels; wide, 788 pixels), dark and light, and every surface, the spec asserts:

- no horizontal overflow in the document or the panel, and the sheet inside the window;
- nothing in a surface's line of chrome sits under the window controls, and the rail's tiles start below them;
- the rail's foot is inside the window, and no rail word is cut short;
- the line of chrome is one line (44 pixels);
- Files and Changes are stacked below 640 pixels of content and side by side from 640;
- text in the rail, the chrome and the footer is at least 4.5:1 against the surface it sits on;
- the native page's bounds match the viewport exactly for Browser, and no native view is shown on any other surface;
- the shell keeps its output across every switch.

That is 90 captures. After the matrix it checks the split diff, pin and unpin, expand and restore at 1280 and 820, the resize handle's keyboard steps, Escape closing a wide overlay panel with focus back on the Tools button, close and reopen with the project sidebar coming back at 820, and reduced motion on every surface. It also checks the keyboard order: opening lands on the rail, the arrow keys move along it, and Tab goes from the rail to its foot (pin, expand, close) and then into the surface's line of chrome.

## Results

Passed on Windows 11 on 2026-09-22: **1 passed**, about 55 seconds per run.

- Normal width is 716 pixels at 1600 (content 657, side by side), 548 at 1280 and 452 at 820 (both stacked). Minimum is stacked everywhere. Wide is docked at 1600 and overlays the panes at 1280 and 820 (788 and 772 pixels, content 729 and 713), side by side in both. `artifacts/tools-rail/layout.json` records every capture's measurements and mode.
- The words in the rail are 12 pixels, the app's floor, a touch above the mock-up's 10.5. "Changes" and "Terminal" fit the 50-pixel tile.
- With reduced motion on, the sheet arrives with `animation-name: none`, and nothing on any surface runs longer than the 1-millisecond floor the setting leaves.
- No renderer errors.

## Images

In `artifacts/tools-rail/`, one per state the note names:

- `browser-1600x1000-normal-dark.png`, `browser-1600x1000-normal-light.png`: the page tab as the line of chrome, the address row beneath, the page at full height.
- `browser-820x560-minimum-light.png`: the tightest browser; tab, address and review controls all reachable.
- `files-1280x800-normal-dark.png`: tree above the open file; the file's own line holds its size, Read only, Wrap lines and its actions.
- `files-1600x1000-wide-light.png`, `changes-1280x800-wide-dark.png`: side by side on a wide panel (the second is an overlay).
- `files-820x560-minimum-dark.png`, `changes-820x560-minimum-light.png`: stacked at the minimum; the change count keeps its words and the branch gives way.
- `terminal-820x560-minimum-dark.png`, `terminal-1280x800-normal-light.png`: shell tabs as the line of chrome.
- `agents-1280x800-normal-dark.png`, `agents-820x560-wide-light.png`: the count and "2 working" on the line of chrome, and the dot on Agents.
- `browser-pinned-1280-dark.png`: the pin pressed at the rail's foot and the footer naming the pinned thread.
- `browser-expanded-1280-dark.png`: expanded to fill the workspace, rail still on the outer edge.
- `changes-split-1280-dark.png`: the split diff.
- `agents-reduced-motion-1280-dark.png`: the panel after reopening with reduced motion on.

The spec writes all 90 captures to `artifacts/tools-rail-run/`, which is ignored.

## Other specs

The specs that name the panel's parts were updated for the rail and pass: `files-panel`, `files-panel-split`, `pane-layouts`, `phase-three-ui-final-fixes`, `subagents`, `terminal-display`, `agent-browser`, and `phase-three-ui` apart from its project-free chat test. Two DOM-renderer terminal checks now count a typed word across a wrapped row, because the rail narrows the terminal and the long fixture prompt wraps the command mid-word.

## Practical limits

This is Windows with fixture providers, a local page and owned working files. It does not cover macOS, where the window controls sit beside the sidebar and the rail's empty top is only a margin, or a live provider account.
