# Pages switch from the keyboard

October 28, 2026. ADR-0158.

## What changed

Ctrl+1 to Ctrl+5 (⌘ on a Mac) open Dictate, Watcher, Threads, Usage and Settings while Sotto's window holds the keys.
They are thread shortcuts by another name: the same setting (`threadShortcuts`), recorder and rules, listed in a new
**Switch pages** group first on Settings › Keyboard. A room opened this way takes focus on its lit tab in the room
switch, as pressing that tab does. With dictation turned off, Dictate has no row and Ctrl+1 does nothing.

## How it was checked

On forge's owned nested Hyprland (two nested compositors, private HOME, bus and runtime), built app, Owl track:
`npm run build`, then `node scripts/verify-linux-window-minimum.mjs --exec node_modules/.bin/playwright test
tests/e2e/page-shortcuts.spec.ts`. Both tests passed:

- **Ctrl+1 to Ctrl+5 open each page from any page**: from Threads, 1 to 5 and back down to 1, each page checked by its
  own heading or lit tab. After each room opened, its lit room tab had focus. Ctrl+3 from the Keyboard page's filter
  box, with text in it, opened Threads. Ctrl+1, Ctrl+2, Ctrl+5 and Ctrl+3 then went through Hyprland's own keyboard
  (`hl.dsp.send_shortcut` to the window) rather than Playwright's, and each opened its page. Settings › Keyboard
  showed Switch pages above the Threads group with Ctrl 1 to Ctrl 5, and recording Ctrl+L on Threads was refused:
  "Focus the prompt already uses Ctrl + L. Pick other keys."
- **With dictation turned off**: the room switch had no Dictate tab, Ctrl+1 left Threads lit, the group had four
  rows and no Dictate, and Ctrl+3 still answered.

The group with that refusal showing, in dark and light at the checked sizes. Nothing overflowed sideways at any size:

- [1600x1000, dark](../../artifacts/page-shortcuts/keyboard-switch-pages-1600x1000-dark.png)
- [1280x800, light](../../artifacts/page-shortcuts/keyboard-switch-pages-1280x800-light.png)
- [820x560, dark](../../artifacts/page-shortcuts/keyboard-switch-pages-820x560-dark.png)
- [820x560, light](../../artifacts/page-shortcuts/keyboard-switch-pages-820x560-light.png)

The runner's own closing check, that nothing under `~/.sotto` changed, fails when the checkout itself lives there, as
a Sotto thread's worktree does: the spec's results folder and the live Sotto's OpenCode state are what changed. The
live Omarchy and Hyprland trees were unchanged.

Unit: `tests/unit/renderer/pageShortcuts.test.tsx` (the listener: each key's page, ⌘ on a Mac, a chosen or removed
key, focus handed only to a room not already lit, a text box, a terminal, a dialog, a page left out, setup not
finished, dictation's own keys, a press already taken and a repeat), the Switch pages cases in
`tests/unit/renderer/features/settings/threadShortcuts.test.tsx`, the defaults in
`tests/unit/shared/threadShortcuts.test.ts`, and in `tests/unit/renderer/agents/threadOptions.test.tsx` the effort
slider leaving Ctrl or ⌘ with a digit alone.

## What else holds these keys

No shortcut used them before. The macOS application menu's only Command accelerator Sotto sets is ⌘, (Settings); its roles
(Reload, Close, Minimize, the zoom keys) use no digit. Electron's default menu on Windows and Linux has none either
(`menuOwnedChords`). The terminal keeps Ctrl+F, Ctrl+=, Ctrl+- and Ctrl+0, and every page shortcut stands down inside a
terminal anyway. Keys typed into Sotto's browser go to that page, not the window. The one handler in the window
that took a digit was the reasoning effort slider, which picked a level on 1 to 9 whatever modifier was held; it now leaves Ctrl or ⌘ with a digit to the page shortcuts.

Not checked in a running app: Windows and macOS. CI loads the spec (`e2e:list`) but does not run it.
