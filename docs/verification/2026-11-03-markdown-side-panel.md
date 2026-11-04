# A linked Markdown file opens in the side panel

November 3, 2026. Follows the November 3 amendment to [ADR-0120](../adr/0120-a-file-link-in-a-reply-shows-the-file-in-its-folder.md) and Zach's pick A of `docs/prototypes/markdown-side-panel-prototype.html`.

## What was exercised

`tests/e2e/markdown-side-panel.spec.ts` on the Windows laptop, in the built app on the Owl track:

- A real headless host paired over its socket, with a thread whose link names a file in its folder, a Markdown file outside it, a text file and a file that is gone.
- Watcher's room on the design fixture, with Watcher's reply linking a file on this computer, at 1600x1000, 1280x800 and 820x560, in dark and light, with reduced motion on. A thread beside Watcher was opened behind the file and brought back.
- The stable track, where main refuses the read.

Not exercised: the desktop against forge itself, real provider models following the instruction, macOS, Linux and a Watcher link read from another machine in the running app. `linkedFileThread` has unit tests for that choice of machine, and the read it then makes is the paired host's read above. Zach's hand test covers forge.

## What it showed

| Case | Result |
| --- | --- |
| Link in a paired host's thread, inside its folder | Tools opens on Files and draws the file read only, "on Forge" after its size, with no Show in File Explorer. `threads-paired-host-1280.png` |
| The minimum window | The panel fits, and the size and place give way before the name. `threads-paired-host-820.png`, `watcher-file-dark-820.png`, `watcher-file-light-820.png` |
| A picture in the file | Stays unloaded, as in a reply |
| Source, and Escape | Source shows the Markdown as written. Escape closes the file, focus returns to the link and Files shows its tree |
| Full path outside the thread's folder | Opens read only |
| A file that is gone | Says so in the panel, and nothing else changes. `threads-file-gone-1280.png` |
| A text file on a paired host | Keeps saying it cannot be shown in a folder here, and opens nothing |
| The link's menu by Shift+F10 | Open in side panel, Show in File Explorer and Copy path, and Escape returns to the link. `threads-link-menu-1280.png` |
| Watcher's room | The file takes the beside pane's place with the divider, clear of the window's controls. `watcher-file-dark-1280.png`, `watcher-file-light-1600.png` |
| A thread beside Watcher | Waits behind the file, and Back to its title brings it back. `watcher-file-over-thread-light-1280.png` |
| Stable | Main refuses with "Opening Markdown files in the side panel is not part of this version of Sotto. Nothing was opened." |

The first runs found two things no unit test had. The preload's guard refused the read for a paired host's thread by throwing, and that throw during the read blanked the window. The guard now lets the read through, a refusal by throwing is said in the panel instead, and a text file's link on a paired host now gets main's sentence rather than a general one. Tools also took focus from the file as it opened, so the keyboard could not scroll it. It now opens quietly and the file takes focus.

The screenshots are in `artifacts/markdown-side-panel/`.
