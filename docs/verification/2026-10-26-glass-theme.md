# Glass, the see-through theme (ADR-0149)

Checked October 26, 2026 on the Windows 11 development laptop (build 26200, 1920 × 1080 at 125%, Windows in dark mode, transparency effects on, energy saver off), from a build of `feat/glass-theme`. macOS and Linux were not run.

## How

`SOTTO_GLASS_EVIDENCE=1 npx playwright test tests/e2e/glass-window.spec.ts` launches the built app with the Owl feature forced on (`SOTTO_OWL_FEATURES=glass-theme=1`, the override unpackaged runs read), Glass chosen for both halves, at 1280 × 800. It puts a desktop behind the window, a field of colour (`bloom`) and then black and white stripes, gives the window the focus, and captures the screen under the window in light and dark, in Threads and in Watcher's room. It then sets the root to in-app glass, the look Linux, Windows 10 and reduced transparency get, and captures the page, and finally leaves Glass for Sotto by night.

## What the captures show

- `artifacts/glass-theme/threads-light-bloom.png`, `threads-dark-stripes.png` and `watcher-light-bloom.png`: the root says `data-glass="see-through"`, so main reported the material drawn, but the room is one flat colour, the same pixel over the colour field and over the stripes (212, 215, 218 by day; 29, 32, 36 by night). Windows drew Acrylic's solid fallback colour, not the blurred desktop.
- A separate Electron 43 probe, a bare window over a red, green and blue gradient, activated with `AppActivate` so it was the foreground window, showed the same: Acrylic flat grey (84, 84, 84), and Mica and Tabbed flat (32, 32, 32). The taskbar in the same screen capture shows no blur either. This machine's compositor draws no material behind any window right now, so **the see-through window itself was not seen on Windows**. The words on the fallback colour read as the test says they would over any desktop.
- `in-app-threads-light.png` and `in-app-threads-dark.png`: in-app glass. The room is the tint over Glass's soft azure, violet and teal gradient, the sidebar frosted a step lighter by day, words dark ink-blue by day and near-white by night.
- `in-app-watcher-light.png` and `in-app-watcher-dark.png`: Watcher's room on the same backdrop. Watcher was not started in this profile, so the room shows Start Watcher and the night scene was not drawn; its reading of a translucent room is covered by `tests/unit/renderer/nightSceneSurface.test.ts` only.
- `threads-dark-left-glass.png`: after choosing Sotto for the dark half, the root lost `data-glass` and the window is Sotto's solid near-black room, with no flash seen between.

## After review

The review that followed added what this run showed was missing. Windows' Transparency effects switch is now read from the registry, so with it off the room keeps Glass's own backdrop; it was on here, so this laptop's flat material is still not detectable (ADR-0149, known limitation). Glass holds Contrast at 100% or above, since lower values took words under 4.5:1 over a black desktop. In-app glass keeps its tint measurable, so Watcher's night scene starts on it. These were checked by unit tests, not captured again.

## Not verified

- The blurred desktop through the window on Windows 11, for the reason above. It needs a Windows machine whose compositor draws Acrylic; the spec runs unchanged there.
- macOS vibrancy and the Linux in-app look on a real Omarchy desktop.
- Watcher's night scene over Glass in the running app.
- Switching the system between light and dark while Glass paints one half only.
- Turning Transparency effects off and on while Glass paints; it was not toggled on this machine.
