# A pointed-at sidebar row makes way for its shortcuts

November 11, 2026. Zach's pick B2 from `prototype/sidebar-hover-row`, with the computer's badge as its symbol (ADR-0201, November 11 amendment). Checked on forge (Omarchy, Linux) in the built app under `xvfb-run`, on Owl with the design fixture, at a 1280x800 window, where the sidebar takes its default 280px, with reduced motion on; then at 1600x1000 and 820x560 with normal motion.

## What was checked

- **Before, on `main` after #2463.** Pointing at "Footer links" left "s." of its project "sotto-site", the computer's badge cut to its icon, then Working, Watcher's owl and three shortcuts. [Dark](../../artifacts/sidebar-hover-row/before-hover-dark.png), [light](../../artifacts/sidebar-hover-row/before-hover-light.png).
- **After.** Pointed at, the same row reads "sotto-site" and the computer's symbol, then its shortcuts; its word, its owl and its time make way. Every two-line row the fixture has, Working and In Needs you alike, kept its whole project ("sotto-site", "notes", "workshop") with the line's words ending 8px before the first shortcut. [Dark](../../artifacts/sidebar-hover-row/after-hover-dark.png), [light](../../artifacts/sidebar-hover-row/after-hover-light.png).
- **What a screen reader hears.** Each pointed-at row's description still says its word, time and details, for example "Codex, Working | 3 min | sotto-site, GPT-5.4, Project folder, Watched by Watcher".
- **The keys.** From the thread on screen, Up three times reaches "Footer links" with the focus ring, and the row reads as pointed at, now with Open beside too. [Dark](../../artifacts/sidebar-hover-row/after-keys-dark.png). This is the path the new `threads-row-pointed-at` design capture takes.
- **A wide sidebar.** Widened to 480px with the divider's keys, the pointed-at row keeps Working, the owl and its time, with the shortcuts on the branch's line, as before. [Light](../../artifacts/sidebar-hover-row/after-wide-480-light.png).
- **Other windows.** At 1600x1000 the sidebar is 280px too, and at 820x560 it opens over the thread from Expand sidebar; in both, in dark and light, the pointed-at row kept its whole project, its word and time made way, and its words ended 8px before the first shortcut.
- **At rest.** Rows keep their words and time; the computer shows as its symbol, "On forge" in its tooltip.

The fixture has no remote computer, so each proof added a `host-badge` with the app's own markup ("forge") to the grouped rows in the page before capturing. Hover states were captured with Electron's `webContents.capturePage()`: under xvfb, Playwright's screenshots of the window returned a frame from before the pointer moved.

## Not checked here

- Windows and macOS. The design baselines are Windows captures; `threads-row-pointed-at-dark.png` and `threads-row-pointed-at-light.png` are new and are taken on Windows with `npm run design:capture`, which also shows whether any existing threads capture moved.
- A real remote computer on the row, and two remote computers at once, which now look alike until pointed at.
