# Mods verification

November 25, 2026, on forge (Omarchy, `xvfb-run` at 1920×1200), with the built app and the `mods` Owl feature on. Zach's
picks are in ADR-0217: B, a Mods page; looks and new parts; made by a thread or by hand; Owl. This first part ships
looks. New parts are the plan's second part.

## What was run

`npx playwright test tests/e2e/mods.spec.ts`, with `SOTTO_E2E_EVIDENCE=publish` for the screenshots in `artifacts/mods/`.
Both tests passed.

1. **A mod at launch.** `mods/oak-sidebar/` was written into the profile before Sotto started, with
   `[data-part="sidebar"] { background: rgb(120, 70, 30) !important; }`. The Threads sidebar painted it
   (`oak-sidebar-1280x800-dark.png`, `-light.png`). `document.elementsFromPoint` over the sidebar showed nothing opaque
   above the aside, so the colour seen is the mod's.
2. **Settings › Mods.** The mod is listed with its switch (`settings-mods-*.png` at 1600×1000, 1280×800 and 820×560, dark
   and light; nothing overflows at the minimum). With reduced motion on, its switches take the window's 1 ms transitions
   (`settings-mods-reduced-motion-1280x800-dark.png`); the page has no motion of its own. Off saved `modsOff: ["oak-sidebar"]` and the sidebar lost the colour; on put it back.
3. **Live.** Two mods written while Sotto ran showed up without a restart: one faded the sidebar to 0.5 at once; one
   with `url(https://example.com/x.png)` was listed with "Its look loads something from outside Sotto…" and its CSS never
   reached the window's stylesheet (`settings-mods-code-and-problem-1280x800-dark.png`, with View its code open).
4. **Turn off every mod.** The View menu item, clicked through Electron's own menu, switched all three off and emptied
   the stylesheet.
5. **Make a mod.** With the fixture provider connected, "Give the sidebar an oak look" made the **Mods** project at the
   profile's `mods` folder and a thread there whose only message is those words.
6. **Held.** With `mods=0` there is no `window.sotto.mods`, no Mods tab and no stylesheet, and the sidebar keeps its
   theme colour even though the mod's folder is there.

## Not checked here

- Windows and macOS. Make a mod's real provider run (an agent writing a mod from the guide) was not run; the fixture
  provider only records the message. Zach's hand test on an Owl build covers both.
- Remove's move to the bin goes through Electron's `shell.trashItem`, which the spec does not press, since the bin
  under `xvfb` is the test machine's own.
