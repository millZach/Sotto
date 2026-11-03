# Settings' footer status on a line of its own

October 30, 2026. The branch `fix/settings-footer-status-clearance` from `main` at f42e1c393, closing #1907 from the desktop UI review (`docs/research/2026-10-29-ui-hillclimb-desktop.md`). Checked on forge (Linux, Omarchy) in an owned nested desktop through `scripts/verify-linux-window-minimum.mjs --exec`, with the built app. Not checked on Windows or macOS.

## What changed

Settings' footer status ("Changes save as you make them.") lay over the page's column, on a patch of canvas, in the room's bottom-right corner. Whatever row scrolled under it lost a corner: a switch, a button or the end of a sentence. It is now the column's last line, in the same corner. The column's scroll ends above that line, so no row ever passes under the status, at a section's heading, at its end or anywhere between. The words, their colour and their place are unchanged; the patch went with the overlap, since nothing lies under the status any more.

Beside the sidebar (the Dictate room, Help, Usage) the status already had the room's foot line, and under a strip the footer's. Settings was the one room that drew it over its content.

## How it was run

```sh
npm run build
node scripts/verify-linux-window-minimum.mjs --exec /usr/bin/env SOTTO_E2E_EVIDENCE=publish "$PWD/node_modules/.bin/playwright" test tests/e2e/footer-status-clearance.spec.ts
```

`footer-status-clearance.spec.ts` opens every Settings section in dark, in light and in dark with reduced motion at 1600x1000, 1280x800 and 820x560. At each section's heading and again scrolled to its end, it lists every control and every run of words whose shown part lies under the footer status's box. The list must be empty. A third test scrolls the Dictate room and Help to their end at the same sizes and checks the same against their foot line.

Before the fix, built from `main` at f42e1c393, the spec (then without the reduced-motion look) failed both Settings tests with the same seven findings in each look, and the rooms passed:

- 1280x800, at the heading: Dictation (the words "These shortcuts are Hyprland bindings…", on Linux) and Threads (the **When finished** choice).
- 820x560, at the heading: Git & worktrees (the **Remove a worktree when its pull request is merged** switch and its words), Watcher ("200k to 1M"), Providers ("Choose what new threads start with in Settings > Threads.") and Performance (the **Tell me when main freezes** switch).
- 820x560, at the end: Keyboard (the **Restore defaults** button).
- 1600x1000: nothing.

After the fix: 4 passed. Only dark and light are photographed.

## What the captures show

The spec writes `artifacts/settings-footer-status-clearance/`; the same captures taken before the fix are in `artifacts/settings-footer-status-clearance/before/`.

- `providers-heading-dark-820x560.png` and `providers-heading-light-820x560.png`, against `before/` of the same names: Providers at its heading at the minimum. Before, the status sat on the line under the provider list; now the column stops above the status's line.
- `application-end-dark-820x560.png` and `application-end-light-820x560.png`, against `before/`: Application at its end. Before, the status's patch cut a notch out of the Reset settings card; now the card ends above the status's line.
- `providers-end-{dark,light}-{1600x1000,1280x800,820x560}.png` and `application-end-{dark,light}-{1600x1000,1280x800}.png`: both sections at their end at every size, nothing under the status.

Compared pixel by pixel with `before/`, the status's words are in the same pixels in every capture. Inside its corner only two things changed: the scrollbar, which now ends above the status's line, and, in dark, the patch's rounded corners, which differed from the canvas by one level in each channel.

## Expected design baseline changes

These are Windows captures and were not regenerated here. On the Windows captures:

- `scale-{100,125,150,200}-settings.png`, `scale-{100,125,150,200}-settings-light.png`, `width-760-settings-dark.png` and `width-760-settings-light.png` grow by the status's line (about 30 pixels at 100%): the status now follows the column's end instead of lying over its bottom padding.
- The Settings captures the size of the window (`settings-feedback`, `settings-feedback-light`, `settings-agents`, `settings-key-verified`, `settings-validation-error`, `settings-validation-error-light`, `focus-switch`, `focus-switch-light`) and the section captures (`settings-providers`, `settings-providers-light`, `settings-capture`, `settings-capture-light`, `settings-transcription`, `settings-cleanup`, `settings-output`, `settings-appearance`, `settings-appearance-light`, `settings-application-privacy`, `settings-application-privacy-light`, `settings-git`, `settings-git-light`, `appearance-system-dark`, `appearance-system-light`) change wherever the page runs past the window's foot: the bottom 30 pixels show the status on its own line instead of rows under it. One whose page ends above the status captures the same.

No capture of the Dictate room, Help, Threads, first-run setup or the widget changes.

## Limits

- Linux only. On Windows the window controls sit at the top right and nothing else differs at the foot, but the Windows captures are what show it.
- Reduced motion is checked but not photographed: the status has no motion of its own.
