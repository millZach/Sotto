# One composer, and the effort word's offer

October 31, 2026, on the Apple silicon Mac, for ADR-0172. The app was not launched (Drake's rule for this machine); the composer was rendered from its real DOM and stylesheets in a headless browser, and the unit suites below ran.

## What was checked

- **The offer in Zach's composer.** A scratch test mounted the Threads page with Zach's composer on, a model offering Low to Max with Medium as its default and set, and Drake's own draft from October 31 ("keyfix app needs major fixes.. super buggy and is not working. pls debug…"). The DOM it drew was rendered with the bundled `main.css` in the T3 Code theme, dark and light, in a pane 760, 520 and 400 pixels wide. "Medium → Extra high" stands after the effort word, the level on the accent's wash, and nothing spills at any width; at 400 pixels the prompt wraps to three lines and the footer keeps one, the permissions down to their shield.
- **Taking it.** A press on the level sets Extra high and the offer goes; from the keyboard, focus moves to the effort word, and a pointer press returns it to the prompt. With the setting fixed (a turn running, a question waiting) no offer is drawn. Assistive technology hears "Extra high effort suggested for this draft." from a status line that is always present.
- **Contrast.** The offer's accent text on its wash is now one of the painted text pairs. At the accent's usual 14% wash, six Omarchy palettes read 4.39 to 4.45:1; at the offer's own 10% wash every built-in half and every stock Omarchy palette reads 4.5:1 or better (`themeTokens.test.ts`, `omarchyThemes.test.ts`, `glassTheme.test.ts`).
- **The score.** "Fix the typo in the README heading" offers nothing. "Why does the sidebar flicker when a thread finishes?" offers High, one above the default. The keyfix draft (it names buggy, not working and debug) offers Extra high, two above. Set to Max, it offers nothing, and it never offers Ultracode. "Please debug this. Debugging shows it; I debugged it" names one kind of work, not three. "Thanks!\nLooks good to me" offers nothing. On the provider's default for a model that names no default, nothing is offered; for one that does, only the offered level is marked in the list.
- **One composer everywhere.** Watcher's first start now puts its permissions in the footer before the model, as a thread's composer does (`watcherView.test.tsx`). An answer draws Zach's composer with the branch controls in the pane header (`threadPaneMenu.test.tsx`). A settings file saved with `composerStyle` loads and drops it (`settings.test.ts`).
- **The ghost.** Not changed. Drake's screen at 17:26 and 17:33 on October 31 shows the next prompt's ghost and its Tab key in Zach's composer on a Codex and an OpenCode thread. `composerNextPrompt.test.tsx` and `watcherNextPrompt.test.tsx` pass unchanged.

Run: `npm run typecheck`, `npm run lint`, and the unit files for the composer, Watcher, settings, catalogs and the theme and scale tokens (20 files, 540 tests, all passing).

## Captures (`artifacts/effort-suggestion/`)

- `offer-dark-760.png`: the offer in a wide pane, dark.
- `offer-dark-520.png`: the same at 520 pixels, the permissions down to their shield.
- `offer-light-400.png`: light, at 400 pixels, the narrowest pane the 820-pixel window leaves.

## Not checked here

- The running app on any platform, and the design captures, which CI runs on Windows. `tests/e2e/composer-style.spec.ts` and `composer-shrink.spec.ts` now check Zach's composer alone; they run in CI.
- Watcher's first-start composer was checked in its unit tests, not drawn. A continuation's options in Zach's composer were neither drawn nor unit-tested here; `continue-thread.spec.ts` covers the flow in CI.
