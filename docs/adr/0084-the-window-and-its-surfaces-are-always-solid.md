# The window and its surfaces are always solid

## Status

Accepted October 14, 2026. Zach asked to remove the Glass opacity slider, the Frosted window switch and the See-through slider from Settings → Appearance, and everything behind them. This supersedes [ADR-0048](0048-the-main-window-can-let-the-desktop-through.md) and amends the Glass part of [ADR-0011](0011-main-window-themes-replace-the-accent.md). It is a removal, not an Owl feature, so it reaches stable with the next release.

Amended October 26, 2026 by [ADR-0149](0149-glass-is-a-see-through-theme-held-in-owl.md): in Sotto Owl, the Glass theme makes the window see-through, and only Glass. Every other theme keeps the solid window, and menus, dialogs, fields, code and the terminal stay solid under Glass too.

Amended October 23, 2026 by [ADR-0126](0126-watchers-conversation-runs-over-a-still-night-scene.md): Watcher's composer is frosted glass over the night scene. The window stays solid, and so does every other surface, the Threads composer included.

## Decision

The main window is always solid. Main makes it with the black `#000000` native background ADR-0009 described, on every platform, with no acrylic, no vibrancy and no launch argument telling the renderer it could frost. The renderer has no `canFrostWindow`, no `data-frost` and no `frost.css`. A pane's terminal drawer paints the theme's terminal colour, and its terminal draws an opaque background. The Linux window keeps `transparent: true`: that clears Electron's Linux resize insets and has nothing to do with frost.

The surfaces that float over the room are solid too. Menus, dialogs, toasts, side sheets and the composer paint what glass painted at 100%: `--tt-glass` is the theme's overlay colour and `--tt-glass-field` its field colour. That is what the `prefers-reduced-transparency` branch in `glass.css` already painted. The backdrop filter on those surfaces stays, though it no longer shows anything: removing it would change the containing block of any fixed-position element inside them. Contrast is the only appearance slider left.

The three settings, `glassOpacity`, `frostedWindow` and `frostSeeThrough`, are gone from `AppSettings`, the schema, the defaults and the patch allow-list. A settings file or first-frame cache saved with them still opens. `parseSettings` and `readCachedAppearance` drop the keys, and the next save writes the file without them. No migration is needed. The patch schema is strict and the renderer and main ship together, so nothing sends the keys any more.

## Consequences

- Anyone who had turned Frosted window on, or lowered Glass opacity, sees a solid window and solid surfaces after the update, with no notice. Nothing they saved is lost but those three values.
- Contrast is checked on solid surfaces only, which is now the only way they are painted. ADR-0048's accepted, unverified contrast over the desktop no longer applies.
- `tests/e2e/frosted-window.spec.ts` and its git-ignored `artifacts/frosted-window/` folder are gone.
- The design baselines were captured with glass at 80%. Captures of open dialogs, menus or the composer change where the surface is now opaque.
- Asking for a see-through window again means a new ADR. ADR-0048 records the options it weighed.
