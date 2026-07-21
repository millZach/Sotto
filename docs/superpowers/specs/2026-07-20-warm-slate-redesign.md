# TalkType — Warm Slate Redesign

Agreed scope from grilling session, 2026-07-20. This spec is the single source of
truth for the redesign work; implementation agents should treat it as binding.

## 1. Reskin (all screens: Home, History, Settings, Help, onboarding, dialogs, toasts, widget)

### Palette: "Warm slate + amber"

Soft warm grays with an amber accent, in both light and dark themes. Reference
values validated in the prototype (`docs/design/PROTOTYPE-home-palettes.html`,
classes `warm-light` / `warm-dark`):

- Light: canvas `#F6F4F0`, sidebar `#F0EDE8`, surface `#FFFEFC`, text `#262220`,
  muted `#6E6660`, border `#DDD7CF`, faint border `#ECE8E2`,
  accent `#C2610A` (contrast `#FFFFFF`), accent-text `#B25605`.
- Dark: canvas `#1B1917`, sidebar `#201D1B`, surface `#262321`, text `#F4F1ED`,
  muted `#ABA29A`, border `#3B3733`, faint border `#2E2B28`,
  accent `#F0A03C` (contrast `#2A1B04`), accent-text `#F3AF58`.

These replace the indigo/violet + cream palette in `src/renderer/src/styles/tokens.css`.
Map onto the existing `--tt-*` token names (keep the token API; change values).
Derive activity/success/warning/error/focus-ring colors to harmonize with the warm
palette while preserving WCAG AA contrast on their surfaces (error stays clearly
red — don't make destructive actions amber).

> **Amendment (as built):** the shipped token values are hardened versions of the
> prototype references above. The accent uses `#B25605` (light) so white button
> text clears 4.5:1; `--tt-border` is `#8A8177` light / `#7D756E` dark so
> interactive borders keep the repo's tested 3:1 contrast against every surface,
> with the prototype's softer `#DDD7CF` / `#37332F` values landing in a new
> `--tt-border-faint` tier for decorative hairlines. Edge snapping keeps the
> widget's 16px soft margin from the snapped edge (matching its original
> bottom-gap aesthetic) rather than a literal flush placement.

### Shape language: tonal, minimal borders

- Surfaces are distinguished by tone (card slightly lighter/darker than canvas),
  not outlines. Borders only where interaction demands them (inputs, keyboard keys).
- Radius ~12px standard. Shadows near-zero (keep a soft shadow for floating
  elements: dialogs, toasts, widget).

### Typography: Manrope

- Bundle Manrope variable font (OFL license) as a local woff2 asset with
  `@font-face`; no network fetch. Use it app-wide (main window + widget).
- Tabular numerals (`font-variant-numeric: tabular-nums`) on stats.
- Add an OFL entry for Manrope to `THIRD_PARTY_NOTICES.md`.

## 2. Layout changes

### Home becomes stats-forward

Top to bottom:
1. **Stats row** — three tiles: **Words**, **Avg WPM**, **Minutes dictated**,
   all computed for "this week" (rolling last 7 days) live from existing history
   entries (`text`, `createdAt`, `durationMs`). No new storage, no new IPC if the
   existing history read channel suffices. Words/minutes include a small sparkline
   of daily values (single accent hue); tiles labeled "this week".
   - Words = sum of whitespace-separated word counts of entry text.
   - Avg WPM = total words ÷ total duration in minutes (0-duration guarded).
   - Minutes dictated = sum of durationMs, displayed in minutes (or h m).
   - Empty history → tiles show 0 states gracefully.
2. **Dictation bar** — compact horizontal bar: mic glyph, "Ready when you are" +
   sub-label, Start dictation button, global-shortcut keys. Reflects live
   dictation state (ready/listening/processing/error) as today's hero did.
3. **Recent** — chrome-less list (no card box): section label, last 3 transcripts,
   "View all →" to History.

The "Transcription model" card leaves Home entirely.

### Chrome removal (all pages)

- Delete the eyebrow ("DASHBOARD") + big page title strip; pages start at content.
- Delete the "Speech stays on this computer" pill.
- Delete the full-width bottom status bar.
- Single status cluster at the sidebar bottom: state dot + "Ready · Local &
  private" (dot color follows dictation state: ready/listening/processing).

## 3. Widget (Sliver design kept structurally; recolored to new tokens)

Four functional fixes:

1. **Contrast rim** — light outer hairline + soft shadow so the widget separates
   from dark and light desktop backgrounds alike.
2. **Multi-monitor** — when a dictation session starts, the widget appears on the
   display the mouse cursor is on, and stays on that display until the session
   ends and text is delivered. (Today it uses a stored placement that pins it to
   one display.)
3. **Idle visibility + click-to-dictate** — new setting "Show floating widget when
   idle" (default ON). When on, the widget is always visible in a subtle idle
   state; hovering brightens it and shows a "click to dictate" affordance;
   clicking starts a session; clicking during a session stops it (same path as
   the global shortcut). When off: today's behavior (widget appears only during
   dictation), click-to-stop still works.
4. **Drag + edge snapping** — the widget can be dragged; on release it snaps
   flush to the nearest screen edge (top/bottom/left/right), preserving position
   along that edge. Persisted (edge + fractional offset) via the existing
   widget placement repository, and re-applied as "same edge, same offset" on
   whichever display the session uses. The pill stays horizontal on all edges.

## 4. Consequences / process

- TDD at the pure seams: weekly-stats computation, edge-snap math, display
  selection. Type-check and lint clean; full vitest suite green.
- Design-capture baselines re-recorded (`npm run design:capture`) after the
  reskin; e2e suite run.
- The palette prototype file moves to a throwaway branch when work completes.
- Settings schema gains the widget idle-visibility toggle (default true) and the
  widget placement persistence shape may be migrated (keep backward compat with
  existing stored placements).
