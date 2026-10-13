# The main window can let the desktop through

## Status

Accepted October 3, 2026. The owner asked for a "somewhat transparent" look where the desktop background bleeds through. They chose a frosted window over a mica tint or a clear window, a switch that works with any theme over a new built-in theme, and frosting the whole room over the sidebar alone, in `docs/prototypes/frosted-terminal-prototype.html`. Amends [ADR-0009](0009-main-window-appearance-apart-from-widget-theme.md) and [ADR-0011](0011-main-window-themes-replace-the-accent.md), which both say the native window background stays black.

## Context

A theme is colour roles only, and every value is canonical `oklch()` (ADR-0011). Glass already blurs what lies under dialogs and menus, but that is Sotto's own page; nothing in the page can see the desktop. Only the window itself can, through a material the operating system draws behind it.

The options considered:

1. **Frosted.** Windows 11 acrylic, or macOS window vibrancy: the desktop and the windows behind show through blurred and tinted. Chosen. Text stays readable over a blur, and Windows resizing and snapping keep working because the window stays opaque to the system.
2. **Mica.** A tint taken from the wallpaper alone, with no shapes. Rejected as too quiet to read as "the desktop bleeds through".
3. **Clear.** A transparent window with no blur. Rejected: text over a sharp desktop is hard to read, and a transparent frameless window on Windows loses snapping and resize edges.

A new built-in theme was also considered and rejected: a theme cannot carry a window material without breaking the oklch-only rule, and the owner wants their own themes to frost too.

## Decision

Two new appearance settings, beside Contrast and Glass in Settings → Appearance:

- `frostedWindow`, off by default. An upgraded install stays solid.
- `frostSeeThrough`, 10-80% in steps of 5, default 40: how much of the desktop shows through the room. It shows only while the switch is on.

Main decides once at start whether the system can draw the material: acrylic on Windows 11 22H2 (build 22621) and later, vibrancy on every macOS Sotto runs on, nothing on earlier Windows (`windowFrostFor` in `platformProfile.ts`). Where it can, the main window is made with `backgroundMaterial: 'acrylic'` (or `vibrancy: 'under-window'`) and a clear `#00000000` background while the setting is on, and keeps the black background otherwise. Changing the setting turns the material on or off in place, without a restart. The widget is never frosted.

The renderer learns that the window can frost from a launch argument, which the preload exposes as `window.sotto.canFrostWindow`. The renderer marks the root `data-frost` only when the setting is on, the window can frost, and the system does not ask for reduced transparency. `frost.css` then stops the room's layers painting the canvas one over another. The page paints the canvas once at the chosen solidity (`--tt-frost-room`), and the sidebar and the docked Tools panel a little more solid on top (`--tt-frost-sidebar`). Floating over the panes, the Tools panel stays solid, so the conversation never shows through it. A pane's terminal drawer is more solid again (`--tt-frost-terminal`), with its terminal drawn see-through over it (ADR-0049). Messages, the composer, inputs, dialogs and menus keep their own surfaces, so text keeps the contrast it has on a solid window. The colours still come from the theme's roles, so every theme, built-in or custom, frosts the same way.

Where the system has no material, the switch is shown disabled with "Needs Windows 11 version 22H2 or later."

## Consequences

- The native background is no longer always black. A frosted window starts clear, so the first frame before the page paints shows the material rather than black.
- Windows draws acrylic solid while another window is in front. The Settings description says so, so the owner does not mistake it for a fault.
- Windows tints acrylic by its own light or dark setting. Sotto leaves `nativeTheme` alone, as ADR-0009 decided, so a light Sotto on a dark Windows has a darker blur under its canvas, and the reverse. Neither pairing has been seen, nor has macOS vibrancy.
- Contrast is checked against the theme's surfaces on a solid window, not over a frosted one, where the effective background depends on the desktop. At the 40% default the room is 60% theme colour, the sidebar 68% and a terminal drawer 78%, over a blur. At the 80% ceiling the room is only 20% theme colour, so text there depends on the desktop. The places where text is densest, messages and the composer, keep their own solid surfaces, and xterm still holds its text to 4.5:1 against the theme's terminal colour. This is accepted, not verified.
- Frost is off by default and no capture turns it on, so the design captures always show the solid room, whatever Windows build they run on. The design captures are local only; CI does not run them. The frosted look is checked by `tests/e2e/frosted-window.spec.ts`. Run with `SOTTO_FROST_EVIDENCE=1`, it also saves screen captures to `artifacts/frosted-window/`. Git ignores that folder, because a capture shows whatever desktop is behind the window.
