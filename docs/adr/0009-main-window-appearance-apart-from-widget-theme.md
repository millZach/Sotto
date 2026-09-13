# Main-window appearance apart from the widget theme

Accepted September 12, 2026 for ticket #73, and partly superseded by ADR-0011: themes replaced the accent, and the chosen palettes now reach the widget. following the approved theme and accent direction in `docs/threads-product-discussion.md`. This supersedes the Crossing rule that the main window is black only with no appearance setting. The main window now has a persisted `appearance` (System, Light or Dark) and `accent` (Teal, Blue, Violet, Rose, Amber or Green). These are new settings fields and do not reuse the existing `theme` field. `theme` stays the floating widget's scheme and keeps following the system exactly as before. Reusing it would have silently changed the widget, or turned a value the Crossing release deliberately ignored into a light main window for anyone who once had it set.

New installs and every settings file written before these fields existed get Dark with Teal, the Crossing room byte for byte. Nobody's window changes on upgrade, even when Windows prefers light; System is an explicit choice. The renderer puts the resolved mode (`data-theme="dark|light"`, never `system`) and the accent on the main window root. `tokens.css` holds the only colour values, as a base dark block, a light block and per-accent blocks. A unit test resolves that cascade for every mode and accent and checks WCAG contrast.

## Considered Options

- **Electron `nativeTheme.themeSource`.** This would give native menus and scrollbars the chosen scheme for free, but it is process-wide. It would drag the widget, which reads `prefers-color-scheme`, into the main window's choice. Native form controls follow the CSS `color-scheme` declared per mode instead.
- **Defaulting to System.** This matches many apps, but it would flip existing users' windows to light on upgrade with no action of their own.

## Consequences

Main-window stylesheets must use `--tt-*` tokens and never branch on the theme themselves. The owned stylesheets are enforced by `tests/unit/renderer/themeTokens.test.ts`. The window's native `backgroundColor` is still black, so an enlarged light window can show a dark edge until Chromium repaints.
