# Main-window themes replace the accent

Accepted September 13, 2026 for the Phase 3 theme replacement. The user rejected the accent chooser and asked for T3 Code's Themes capability instead. This supersedes the `accent` half of ADR-0009. The `appearance` mode (System, Light or Dark) stays as ADR-0009 describes, and so does the rule that the widget's `theme` setting is not the main window's look.

Amended September 22, 2026 by ADR-0024: the built-ins are now six palettes of Sotto's own (Sotto, Hush, Linen, Nocturne, Tropic, Citrine), T3's five are retired and fall back to Sotto, the gallery is a Light column and a Dark column, and on the default theme the mark is the app icon. What follows about the built-ins' names and ids, the cards and the brand describes the look before that.

Amended September 18, 2026 for the Threads page redesign: the Sotto card, still on the id `t3-code`, now carries Sotto's own palette — the approved Threads look — instead of T3 Code's zinc, and both halves start on Sotto. The other five built-ins are still exact T3 imports. Keeping the id means every saved selection and exported file resolves as before; a user who liked T3's zinc is the case this trades away, and the editor's duplicate is where that palette can be kept.

The main window now has five settings in place of `accent`. `lightTheme` and `darkTheme` name the theme that paints each half; the halves are chosen separately, as in T3 Code. `appearanceContrast` runs 50-200% and `glassOpacity` runs 40-100%, both in steps of 5. `customThemes` holds up to 64 user themes. Both halves start on Sotto (id `t3-code`); a half whose theme is removed also falls back to Sotto. Upgraded files keep their mode and lose `accent`. The patch schema still accepts an `accent` key and ignores it, so an older caller cannot fail a whole save. The library is read one theme at a time, so one damaged entry never costs the others.

The colour roles, the T3 theme file format and the id rules follow T3 Code at commit d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3 (MIT, T3 Tools Inc.). Five of the six built-in palettes are exact T3 imports, and a theme exported from either app imports into the other. T3 keeps its library in localStorage. Sotto keeps it in `settings.json`, so it survives restarts and is validated in main like every other setting.

Sotto names the built-ins itself, at the user's request: Sotto, Rose, Fern, Tide, Copper and Dusk. T3 calls them T3 Code, T3 Chat, Grove, Ocean, Ember and Iris. Only the display names differ. The ids stay T3's (`t3-code`, `t3-chat`, `grove`, `ocean`, `ember`, `iris`), so saved selections and theme files keep resolving, and every palette but Sotto's is unchanged. Custom and imported themes keep whatever names they have. The editor will not give a new theme a built-in's name, so the gallery never shows two cards with one name.

## How a theme paints

`state/appearance.ts` resolves the mode and the half's theme. It writes every role onto the window root as an inline `--theme-*` custom property in canonical `oklch()` form, plus `data-theme` and `data-theme-id`. `tokens.css` derives every `--tt-*` token from those roles. Contrast and glass enter the same way, as `--theme-contrast-*` and `--theme-glass-opacity`, and the glass surfaces in `glass.css` blur what lies beneath them. Stylesheets still use only `--tt-*` tokens, and `themeTokens.test.ts` still enforces that.

Every colour that reaches the root has passed `isCanonicalThemeColor`: digits, dots, spaces and one slash inside `oklch()`. A saved file, a pasted T3 or VS Code theme, or an Open VSX download therefore cannot put `url()`, `var()` or a second declaration into the page. Import errors name the failing role in plain words.

The editor paints a draft over the saved look (`data-theme-id="__preview"`) until Save or Cancel. It carries T3's simple and advanced colour sets, the "Pick app color" inspector and corner-grip resizing. The inspector swaps a role for a sentinel colour, compares painted colours, and restores the role within the same task. Anything else that observes the root or the page must ignore those probes. Colour readers mark their hidden elements with `data-theme-token-probe`. Root style observers skip batches whose declarations end where they began (`rootStyleUnchanged`), and body observers skip records that only add or remove probes and inspector overlays (`isTransientPaintMutation`). Without this, the diagram palette and the spotlight woke each other every 500 ms.

## Open VSX

T3 Code searches Open VSX and installs colour themes from its web client. Sotto's renderer has no network under its content security policy. Main does the work instead, behind `window.sotto.themes.searchOpenVsx` and `installOpenVsx`. The renderer sends a namespace and name, never a URL. Only `open-vsx.org` and its two storage hosts are contacted. Every response has a byte limit, and a VSIX must match its published SHA-256. Only permissively licensed extensions are offered. The archive is read in memory with bounded entries and ratios, no file is written and no code runs. Only colours survive, through the same VS Code importer as a pasted file. `docs/verification/phase-3-themes-network.md` records the limits. The checksum proves a file is the one Open VSX serves, not that its publisher is trustworthy. Export goes through a native save dialog in main.

## Both windows

The selected light and dark palettes also colour the Sotto mark, the voice sphere and the floating widget. That supersedes ADR-0009's frozen widget palette, at the user's request. The widget keeps resolving its own mode from the system as before, but paints that mode with the chosen theme for the matching half. The branding worker implements the widget and mark side and the settings projection they read; this ADR records the rule both windows follow.

## Not carried over from T3 Code

- **Server environment themes.** A T3 server watches `<stateDir>/themes/*.json` and streams palettes to connected clients, so a machine can retint every client. Sotto has no server and no remote clients, and there is nothing to publish to.
- **`t3 theme` CLI.** This sets an environment's `defaultTheme` for connected clients. Sotto has no environment or CLI, and a user's own choice is made in Settings.
- **Mobile appearance.** T3's mobile app keeps its own appearance settings. Sotto is desktop only.

## Considered Options

- **Keeping the accent alongside themes.** A palette already defines its accent. Two sources for one colour would bring back the tint the user asked to remove.
- **Themes in localStorage, as T3 does.** This would skip main-side validation, and a profile reset would lose themes while other settings stayed.
- **Fetching Open VSX from the renderer.** This would need `connect-src` holes in the content security policy and would give page code a network path.

## Consequences

The accent capture tuples in the design gate became one tuple per built-in theme in each room. Other workers' E2E specs that still pass `accent` keep working because the key is ignored. The window's native `backgroundColor` is still black, as ADR-0009 notes. Any new surface must take its colours from `--tt-*` tokens, or the theme and contrast settings will skip it.
