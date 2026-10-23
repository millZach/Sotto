# The look tune-up, in the built app

October 22, 2026, on Windows 11, from branch `feat/filled-cards-and-rectangle-buttons` (ADR-0110, Zach's picks from `docs/prototypes/look-tuneup-prototype.html`: containers B, controls N1, providers P1, Usage scaling with the room, the sidebar tune). The branch already had `main` merged in, with Watcher's night scene (#1363), Visualize and the prototype-ready strip (#1360). Everything was checked in the built app (`npm run build`) with a throwaway Playwright spec, which was not kept. It reused the setup of the specs named below:

- Threads, Settings and Watcher ran on the design-threads fixture, on the Sotto Owl track. Main's Watcher was stood in for by a seeded projection watching three threads, as `watcher-night-scene.spec.ts` does.
- The prototype-ready strip and a question card ran in a real project folder holding a prototype page, as `prototype-ready.spec.ts` and `question-prototype-pages.spec.ts` do.
- Usage ran on the native usage fixture with two weeks of seeded history, as `usage-dashboard.spec.ts` does.

Each surface was captured in dark and light at 1600x1000, 1280x800 and the 820x560 minimum, in the default Sotto themes with reduced motion: 62 windows in all, plus Git's lower half and keyboard focus at 1280x800. Every image was looked at.

## What was checked

- **Containers are cards.** Settings groups, Usage's index and chart, each provider card and the provider's detail, the composer, the question card and the prototype-ready strip are filled, with no outline, in both modes. A row on a card is divided by the inset line, and fields and segmented tracks on a card take the inset. The user's message bubble is filled, with no outline.
- **No pills.** Buttons, fields and Watch are 6px squares, and so is the send button. The composer's pickers are filled 5px chips, tags such as the question's Greeting are 4px, and toggles are rounded-square switches. Each provider's status is a dot and a word.
- **Segmented controls.** Dictate / Threads, Watcher's Conversation / Watched / Visualize, Usage's views and Settings' choices (Git's Diff layout and Default diff file state) are a sunken track with the chosen segment raised. In light the chosen segment is plainly white on the track. In dark it is a step lighter, with brighter words.
- **Provider cards.** Each toggle is on its name's line. A selected card wears the accent edge and wash.
- **Usage.** The index and chart grow with the room. At 820x560 the index wraps into two columns, with nothing sideways. The Usage capture also checks the page and the room for overflow, numbers for clipping, and every word for 4.5:1, at all six windows. All passed.
- **The Threads sidebar** is 280 pixels at 1600 and 1280 and 260 at 820, with the larger text.
- **Nothing overflows.** `pageBoundProblems` found nothing in any of the 62 windows.
- **Focus.** Keyboard focus was shown on a Settings section, a select, a provider's toggle, the transcript and Dictate / Threads. No ring is cut by a card.

## Pills, measured

In each window, the spec listed every visible element whose computed border-radius was at least half its height while its width was more than 1.5 times its height.

- None in 58 of the 62 windows, including Appearance at 820. No element in any window had one fully rounded end either.
- Settings > Appearance at 1600 and 1280, both modes: three, the same each time. Two `span` elements 69x3 and `i.effort-sample__text` 136x3, each with a 2px corner. They are the 3-pixel lines that stand for text inside the live preview and the effort sample. The rule counts them because 2px is more than half of 3, but they are drawn lines rather than controls, and ADR-0110 gives bars 2px corners. At 820 they are below the fold.

## Fixed on the way

- **A provider's name ran into its toggle.** The toggle's words are hidden on a provider card, but its grid kept the empty words column and its 12px gap. So the toggle took 48 pixels where the name's line kept 36 free, and at 1600 and 1280, Claude Code sat 4 pixels from its switch. The toggle is now just its 36 pixel track. Each name now has at least 15 pixels before the toggle at every size, none is cut short, and every toggle sits 13 pixels from its card's edge.
- **Settings' selects had no arrow.** Settings paints its fields with a `background` shorthand, which also drops the chevron `.tt-select` draws. On `main` the selects were outlined fields with no arrow. As filled boxes they read as neither a field nor a choice. The chevron is back, centred on the 38 pixel field, in `--tt-text-muted`.

## Captures

In `artifacts/look-tuneup/`:

- `usage-overview-dark-1600x1000.png`: the index and chart scaled to the widest room.
- `usage-overview-light-820x560.png`: the index wrapped into a grid at the minimum.
- `settings-git-light-1280x800.png`: Settings groups as cards, the example on the inset, selects with their arrow, toggles.
- `settings-git-bottom-dark-1600x1000.png`: segmented controls on a card, dark.
- `settings-providers-dark-1600x1000.png`: four provider cards in a row, each toggle on its name's line, the selected card and the detail card.
- `settings-providers-light-820x560.png`: two columns of provider cards at the minimum.
- `settings-appearance-dark-1600x1000.png`: Appearance, with what is still outlined (below).
- `thread-prototype-strip-light-1280x800.png`: the prototype-ready strip and the composer as cards, the composer's pickers.
- `thread-question-card-dark-1280x800.png` and `thread-question-card-light-820x560.png`: the question card, its tag and the page row.
- `threads-sidebar-composer-dark-1280x800.png` and `threads-sidebar-composer-light-820x560.png`: the sidebar at 280 and 260 pixels, Dictate / Threads, and a running thread's composer.
- `watcher-conversation-dark-1280x800.png` and `watcher-conversation-light-820x560.png`: Watcher's tabs, composer and dock with the night scene and its thread owls.
- `watcher-visualize-light-1600x1000.png`: Visualize, with its tab raised.
- `focus-provider-toggle-dark-1280x800.png`: keyboard focus on Claude Code's toggle, inside its card.

## Specs and tests run

After the two fixes and a fresh build, each spec ran on its own, and all passed:

- `usage-dashboard`: 3 tests.
- `git-settings`: 1 test.
- `providers-this-computer`: 1 test.
- `prototype-ready`: 1 test.
- `watcher-night-scene`: 4 tests.
- `watcher-picture`: 5 tests.
- `thread-sidebar-resize`: 2 tests.

`tests/unit/renderer/themeTokens.test.ts` and `designSystem.test.tsx` pass (100 tests). Of `tests/unit/release` and `tests/unit/scripts`, 443 pass and two fail. Both failures come from the development machine, not the branch:

- `notices.test.ts` reports version drift for Electron. The installed Electron is 43.1.0, and the lockfile asks for 43.8.3.
- `stableHostPromotion.test.mjs` wants Node 24.22.1 or later, and this machine has 24.14.1.

Because of that, the app above ran on Electron 43.1.0.

The Threads, Usage, prototype-ready strip and question-card captures were taken before the two fixes. The fixes do not touch those surfaces. The Settings and Watcher captures were taken after them.

## Left as it was

These are outside the change or need a decision, and are left for Zach:

- **Appearance still has outlined boxes.** The Light and Dark theme halves, the live preview and its inner window, and the effort sample are 1px outlines. The Contrast block under them is already a card. On the theme halves, the outline marks which half paints the window. Making them cards means choosing another way to show that, so this needs a decision. The effort sample's chips are also outlined, where the real composer's are filled.
- **Visualize's project groups are outlined.** The boxes around a project's threads in Watcher's picture are 1px outlines, as in the picture Zach picked on October 22.
- **The selected thread in the sidebar has an accent edge**, as on `main`. The sidebar tune changed only its width and text.
- **Check for client updates** is a divided row under the provider's detail card, not a card of its own.
- **Owls at the edge.** At 820x560, Watcher's rail of thread owls sits at the window's edge, and a focused owl's ring is cut on its right by the pane. This is the same as on `main` (#1363).
- **Other selects.** The arrow was put back only on selects in a Settings group's rows. Selects on other pages were not looked at.

## Not verified

- macOS and Linux. Everything here was on Windows.
- Themes other than the default Sotto light and dark.
- The design capture baselines. `npm run design:capture` and `design:verify` were not run, and the baselines were not regenerated. They change wherever a card, a control or the sidebar shows, as ADR-0110 says, and are regenerated on the machines that hold them.
- The floating widget and Omarchy's shell pill, which keep their own look.
- Normal motion. The captures were taken with reduced motion on.
