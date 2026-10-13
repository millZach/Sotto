# Frosted window and terminal drawer verification

October 3, 2026, on `feat/frosted-window-and-pane-terminal` from `main` at 54f10c87. The owner asked for a theme the desktop shows through, and for T3 Code's terminal in the bottom third of a thread. From `docs/prototypes/frosted-terminal-prototype.html` they picked a frosted window over mica or a clear one, a switch for any theme over a new theme, the whole room frosted over the sidebar alone, and drawer variant A: the drawer below the composer with its shells as tabs. They also asked for drawer shells separate from the Tools panel's terminal, a see-through drawer under frost, and Ctrl+J as its shortcut. The decisions are ADR-0048 for the window and ADR-0049 for the drawer. The glossary terms are **Frosted window** and **Terminal drawer**.

## Frosted window

- **The system draws the material.** With `frostedWindow` on, Windows 11 (build 26200 on the development machine) reported `DWMWA_SYSTEMBACKDROP_TYPE` = 3, transient window (acrylic), for Sotto's main window, read with `DwmGetWindowAttribute` on the window's handle. With the setting off, it reported 2 and the black background was kept.
- **The room lets it through.** In `tests/e2e/frosted-window.spec.ts`, the root carries `data-frost` and the body's canvas has alpha below 1 only where `window.sotto.canFrostWindow` is true. The Settings switch turns both off and back on without a restart. Where the system cannot frost, the switch is disabled and says "Needs Windows 11 version 22H2 or later."
- **Which surfaces are see-through.** With a bright gradient under the page in place of the desktop, Threads, Settings and Dictate all showed it through the room and the sidebar, in dark and light. The composer, inputs, message bubbles and the terminal kept their own surfaces. Those captures and the spec's screen captures show what is behind the window, so none is committed. `artifacts/frosted-window/` is git-ignored for that reason.
- **Not verified automatically: the focused look.** A window launched by a test cannot take the foreground on Windows, and acrylic is drawn solid while a window is in the background. Every automated capture therefore showed the solid fallback. The owner checks the focused look by eye.
- **Not verified at all: macOS, and acrylic's own tint.** Vibrancy is covered only by unit tests of the window options. Acrylic is tinted by Windows' own light or dark setting, which Sotto does not change (ADR-0009 keeps `nativeTheme` alone), so a light Sotto on a dark Windows, or the reverse, has not been seen. The room's own canvas, 60% at the default, sits over that tint.
- **The drawer and the docked Tools panel frost too.** In the same spec, an open drawer paints a background more solid than the room and its terminal area is clear. The docked Tools panel sheet takes the sidebar's frosted colour; floating over the panes, it stays solid.

## Terminal drawer

`tests/e2e/pane-terminal.spec.ts` runs against real ConPTY:

- the pane's **Terminal drawer** button opens the drawer and starts PowerShell in the thread's working copy, with no "Start terminal" step;
- a command's output arrives, and the Tools panel's terminal lists no session;
- Ctrl+J from inside the shell hides the drawer, focus goes back to the composer, the shell keeps running, and a half-typed line was not run, so the key never reached the shell;
- Ctrl+J again brings the same shell back with focus in it, and Escape goes to the shell without hiding the drawer;
- closing its last shell hides the drawer and ends the session.

Captures. The first four were made with `SOTTO_PANE_TERMINAL_EVIDENCE=1` and a short prompt, so no folder path shows. The fifth was made by hand with a throwaway probe:

- `artifacts/pane-terminal/drawer-dark-1600x1000.png`
- `artifacts/pane-terminal/drawer-dark-1280x800.png`
- `artifacts/pane-terminal/drawer-dark-820x560.png`: the minimum window. The drawer, composer and header fit without clipping.
- `artifacts/pane-terminal/drawer-light-1280x800.png`
- `artifacts/pane-terminal/drawer-frosted-gradient-1280x800.png`: frosted, with a bright gradient under the page standing in for the blurred desktop. The room, the sidebar and the drawer let it through, with the drawer the most solid. The terminal's own area shows it too, and its text stays readable.

Three problems were found in the running app and fixed before these captures:

1. **The first click in an unfocused pane missed.** In a split, a pane's first click focuses it, and focus adds the Tools button to that pane's header. With the Terminal button placed before Tools, it moved 32px between pointer down and up, and the click was lost. Terminal now sits after Tools, so focus never moves it.
2. **The first prompt was cut off in a narrow pane.** A new shell started at 80 columns. In a split pane narrower than that, PowerShell's first prompt was hard-wrapped at 80 and ran past the pane. The drawer now starts each shell at an estimate of its own width.
3. **A wide terminal pushed the pane sideways.** When the drawer opened at its final size, the terminal fitted itself to its own oversized box: a flex item grows to fit its content unless its minimum width is zero. Typing past the middle then scrolled the whole pane, header included. The drawer now gives the terminal a zero minimum width and clips it, so the terminal fits the drawer at all three sizes and the pane never scrolls.
