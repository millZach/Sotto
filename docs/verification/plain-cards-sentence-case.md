# Plain cards and sentence-case labels

October 30, 2026. The branch `fix/cards-without-stripes-sentence-case` from `main` at d5ec2219b, closing #1830 and #1829 from the desktop UI review (`docs/research/2026-10-29-ui-hillclimb-desktop.md`, findings 12 and 11), as Zach picked them in `look-fixes-prototype.html` on the tag `prototype/ui-hillclimb-desktop`. Checked on forge (Linux, Omarchy) in an owned nested desktop through `scripts/verify-linux-window-minimum.mjs --exec`, with the built app and the design capture profiles. Not checked on Windows or macOS.

## What changed

**No status edge (#1830).** Six kinds of card drew a 2 or 3 pixel coloured stripe down their left edge: the request card (and its uncertain and recovered forms), the ready prototype, a lifted question, the client update card, a provider's refusal, and a thread's error and notice lines. The docked questions box drew a warning outline for an unconfirmed answer. Zach picked no stripe and no tint, so each is now its plain fill, and its heading, sentence and buttons say what it needs. Fills and text colours are unchanged, so every pair keeps the contrast `themeTokens.test.ts` already holds it to (4.5:1 for text on the card, the canvas, the surface and the sunken surface in every built-in theme).

**Sentence case (#1829).** No renderer stylesheet sets `text-transform: uppercase` any more. The five rules were the Journal's day headings, its stats headings, the theme editor's colour groups, setup's step line and setup's eyebrow. The words were already written in sentence case, so they now read as written: "Today", "Speed, last 30 days", "4-day streak", "Friday, July 10". Setup's step line reads "Step 1 of 10" with no step name after a dot, and the welcome's "Welcome to Sotto" eyebrow is gone.

## How it was run

```sh
npm run build
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/plain-cards-sentence-case.spec.ts
```

`plain-cards-sentence-case.spec.ts` (3 passed) opens each surface in dark, in light and in dark with reduced motion, at 1600x1000, 1280x800 and 820x560:

- first-run setup on its welcome, where the step line must read "Step 1 of N", "Welcome to Sotto" must not be on the page, and no element may be drawn in capitals by its style;
- the Dictate room with the populated Journal, with the same check for capitals at each size;
- Visual gate flake in the `design-threads` fixture, waiting on a permission, whose card's left border must be drawn exactly as its top one is (1px transparent).

The setup and Dictate captures also pass the design captures' clipping check. The Threads capture leaves that check to `design-capture-threads`, since the quiet composer's stop button reports its own content as clipped there with or without this change.

## What the captures show

- `artifacts/plain-cards-sentence-case/permission-light-1600x1000.png`: the permission card in light at 1600x1000, a plain fill with "Run a command in workshop", the command and Deny and Allow, and no stripe.
- `artifacts/plain-cards-sentence-case/permission-dark-820x560.png`: the same card in dark at the minimum window.
- `artifacts/plain-cards-sentence-case/dictate-dark-1600x1000.png`: the Dictate room in dark with its stats headed "Today", "Speed, last 30 days", "4-day streak", "Where, last 30 days" and "This month", and the days "Today", "Yesterday" and "Friday, July 10".
- `artifacts/plain-cards-sentence-case/dictate-light-820x560.png`: the same in light at 820x560, where the stats become a row of "Today" and "This month".
- `artifacts/plain-cards-sentence-case/setup-welcome-light-1600x1000.png`: setup's welcome in light, "Step 1 of 10" over the bar and the mark straight over the heading.
- `artifacts/plain-cards-sentence-case/setup-welcome-dark-820x560.png`: the same in dark at the minimum window.
- `artifacts/plain-cards-sentence-case/setup-welcome-dark-reduced-motion-1280x800.png` and `artifacts/plain-cards-sentence-case/permission-dark-reduced-motion-1280x800.png`: setup and the permission card at 1280x800 with reduced motion, unchanged from the moving look.

## Design baselines this changes

The committed baselines are Windows captures and were not regenerated here. These will differ and need regenerating on Windows:

- every setup step, `onboarding-step-1-welcome` to `onboarding-step-9-phone` and `onboarding-step-4-speech-model-light`, and `scale-100-onboarding` to `scale-200-onboarding` (the step line, and the welcome's eyebrow);
- every capture of the Dictate room, whose stats and days were in capitals: `dictate-ready`, `dictate-listening`, `dictate-pasted`, `dictate-processing`, `dictate-error`, `dictate-reduced-motion`, `dictate-journal-open`, `dictate-journal-more`, `dictate-journal-search`, `dictate-journal-off`, `dictate-journal-empty`, `focus-switch-tab`, `focus-navigation`, `focus-input`, `focus-destructive`, each with its `-light` twin where it has one, `theme-*` and `accent-*` (dark and light), `scale-*-dictate`, `scale-*-journal` and `width-760-dictate`;
- `threads-populated` and `threads-populated-light` (the permission card), and `threads-stopped`, `threads-search` and their light twins where the open thread shows an error line.

## Limits

- The client update card, the ready prototype, a lifted question, a provider's refusal and a thread's error line were not opened in the running app; `themeTokens.test.ts` reads their stylesheets and fails if any of them draws a left edge or a coloured border again.
- The setup card's outline and its size are #1831 and #1824, in a later change.
