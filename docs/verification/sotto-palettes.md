# Sotto palettes verification

September 22, 2026, on `feat/sotto-palettes-day-night` from `main` at 0c700d75. Zach picked the Light and Dark
columns and six palettes from three rounds of throwaway prototypes on `prototype/theme-picker`, which stays off
`main`. The decision is ADR-0024; the glossary terms are **Ink** and **App icon brand**.

## Contrast

`tests/unit/shared/themes.test.ts` checks every half of every built-in: text, muted text, sidebar text, bubble
text, accent and send-button foregrounds, code, placeholder and the status surfaces each read at 4.5:1 or better on
the surface they sit on. The five new palettes were grown from a canvas and an accent. Four foregrounds that came
out just under 4.5:1 (Hush and Nocturne light muted text, Tropic dark muted and placeholder text) were darkened or
lightened in 0.005 lightness steps until they cleared 4.55:1. Sotto's dark accent is exactly the icon's
`#47b8a9`; the light accent is `oklch(0.53 0.095 186)`, because `#47b8a9` on the light canvas is about 2.4:1.

## Rendered evidence

`tests/e2e/theme-palettes-evidence.spec.ts`, run with `SOTTO_THEME_EVIDENCE=1` after `npm run build`, launches the
built app on throwaway profiles. The images are in `artifacts/verification/sotto-palettes/`.

- **The page at every review size.** `appearance-1600x1000-dark.png`, `appearance-1280x800-dark.png`,
  `appearance-820x560-dark.png` and the three `-light` twins. At each size the spec asserts that no column, the
  scheme track or the Themes bar is wider than its box. At 1600 the columns sit beside the Live appearance panel.
  Below 1050 the panel moves under them, and at the 820x560 minimum both columns still fit side by side with
  every name whole.
- **Every built-in on the Threads page.** `threads-<id>-dark.png` and `threads-<id>-light.png` for `t3-code`
  (Sotto), `hush`, `linen`, `nocturne`, `tropic` and `citrine`, on the design fixture's busy thread with a pending
  command request. On Sotto dark (Ink) the thread's room is near black and the sidebar a lighter graphite; the
  selected row, the send button and the thinking dot are the icon teal.
- **The mark.** The spec asserts `data-brand="app-icon"` on the root and the mark's tile `#47b8a9` and glyph
  `#000000` in both modes on the default theme, then paints Citrine, where the attribute is gone and the tile
  follows Citrine's accent (`appearance-citrine-light.png`).

## Behaviour covered by unit tests

- The columns list the six built-ins in order, then custom themes only under the halves they carry. A press saves
  only that half. The column for the resolved mode is described as painting the window now
  (`tests/unit/renderer/themeLibrary.test.tsx`).
- The keyboard path: each radio group is one Tab stop, the arrows, Home and End move and choose as they go and wrap,
  and Tab runs the scheme, Create theme, Add theme, the Light column and then the Dark column
  (`themeLibrary.test.tsx`, `settingsView.test.tsx`).
- A half saved on a retired T3 id (`t3-chat`, `grove`, `ocean`, `ember`, `iris`) reads back as Sotto, and those
  ids are free for an imported theme while T3's aliases stay reserved (`tests/unit/shared/settings.test.ts`,
  `themes.test.ts`).
- `data-brand` is set only while the default theme paints, never for an editor draft
  (`tests/unit/renderer/appearance.test.ts`). The widget sets and releases it from the palette's `appIcon` flag
  (`widgetApp.test.tsx`), and the mark and orb follow it (`themeBrand.test.tsx`).
- The first-frame palette in `tokens.css` is Sotto's new one in both modes, so a launch does not flash the old
  look before settings arrive (`themeTokens.test.ts`).

## Gates

Run on Windows after rebasing onto `main` at 0c700d75: `npm run typecheck`, `npm run lint`,
`npm test -- --maxWorkers=2` (4531 passed, 41 skipped) and `npm run notices:verify` (174 components) all pass.
`npm run design:capture` regenerated the baselines on purpose. The default theme's dark room and accent changed, so
nearly every capture moved; the five T3 `theme-*` pairs are gone and the new built-ins' pairs are added.
`npm run design:verify` then verified all 144 tuples.

After the PR opened, `main` moved to d1c9d77a, which refreshed the Application settings baselines. It was merged
in, the baselines were captured again on the merged code, and the gates passed again: 4568 unit tests passed and
41 skipped, and `design:verify` verified all 144 tuples. One verify run failed first, because `focus-input.png`
had a stray "." in the History search box: the capture window takes real keyboard focus, and a key pressed on
the machine during the run landed in the field. The next run passed unchanged.

The Playwright specs that touch Appearance and themes were updated and run against the built app. Four tests fail
here, and fail the same way on the base commit, 93b8d016, built in a separate worktree, so they are not this
change: `phase-three-themes` "a spotlight over a drawn diagram goes quiet" (idle redraws) and "a minimized editor
is one row" (it overlaps Send at 820x560); `phase-three-final-visual-fixes` "the composer beside a pending
permission" (no Send button in that pane); and `agent-attention` "Later returns to the orb" (the Mode tab is not
found). On the base commit the `phase-three-themes` journey fails at its old gallery step too; here it passes.
