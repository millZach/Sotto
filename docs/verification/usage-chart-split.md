# Splitting Usage's Per day chart

October 21, 2026. Local verification of `feat/usage-chart-split`, which builds the Per day chart Zach picked from the `prototype/usage-compare-models` prototype: variant **C · Split the chart**, recorded in [ADR-0083](../adr/0083-usage-counts-every-clients-work-on-each-computer.md#splitting-the-per-day-chart). Nothing was installed, packaged or published.

## What changed

Prompts and Tokens each have a **Per day** head with **Show** (Total, By provider, By model) and **Bars | Lines**, two radio groups with one Tab stop each. Total draws what the chart drew before: prompts in the accent, tokens as input under output, and on Lines one line of input and output together. By provider draws one series per provider with activity in the range; By model draws the top five models by the stage's own measure and **Other (n)** for the rest. Bars stack and lines do not. A value list above a split chart names every series with its range total and switches to a day's values when a day is pointed at or read from the keyboard; it is a fixed grid, so nothing moves when the values change. Keyboard reading announces every series' value through the page's live region.

The page's read has daily totals only, so each drawn series is one more read filtered to its provider or model (the spellings older hosts stored included), made only while a split is shown. Other is the day's total less the drawn series, never below zero. While the series are read, the value list names them, the plot keeps its size and says it is reading, and nothing is drawn. A failed read says so, says nothing was lost, and offers Try again. Choosing, ranking, Other, stacking maxima and the value list live in `usageChartSeries.ts`, a pure module with its own tests.

## Review fixes

Two reviewers read the branch and found six things; each is fixed at its cause and has a test that failed before the fix.

- **A read that missed a computer was drawn as zeros.** A series' filtered read is drawn only when it answers for every computer the page's own figures came from, each ready and with all its days. A computer left out, offline, failed or without days used to read as zero, and Other took its share. Now that read counts as failed: the note says nothing was lost and offers Try again, and nothing is drawn.
- **Missing and partial token counts were lost.** Each series keeps, for every day and for the range, whether its token figure was reported in full, in part or not at all. The value list shows a dash read as "Not reported" and "at least" as the rest of Usage does, and the keyboard announcement says the same in words. Other's own record counts are the total's less the drawn series', so Other says "at least" only when its own records left something out.
- **Other's models and each model's provider were only in a tooltip.** Under a chart split by model, **Each model's provider, and what Other holds** is the next Tab stop after the chart. It opens a list in plain words and closes on Escape, as About these numbers does. It sits under the chart, so opening it moves nothing above it.
- **By model on Prompts could leave out the most-prompted model.** Each computer lists at most 200 models, ordered by tokens, and the query has no way to rank by prompts without a schema change. So when a list was cut short the chart says "Ranking is incomplete" beside it on Prompts, and on Tokens when more than one computer's lists are joined; one computer's top five by tokens are still its top five.
- **A split with nothing to draw said it was reading forever.** With no series there is no read, so the answer is ready at once: Tokens says "No token counts in this range", Prompts "No prompts in this range".
- **Three copies of one check.** Muse and OpenCode now use `tokenCount` from `nativeUsage.ts` rather than their own copies. It lives there, not in `observedUsage.ts`, because `observedUsage.ts` already imports `nativeUsage.ts` and the reverse would be a cycle.

## Series colours

Themes carry T3 Code's roles, none of them a categorical hue, so the series colours are constants per mode in `tokens.css`, as the provider marks are. Slots 1 to 6 are blue, orange, cyan, magenta, violet and amber; Other is a grey. A provider always takes the same slot (Codex 1, Claude Code 2, Devin 3, Grok Build 5). A model keeps its slot while it stays drawn and a newcomer takes the lowest free one, so a range or filter change never repaints the models that stay.

| Token | Dark | Light |
| --- | --- | --- |
| `--tt-chart-1` | `#3792fd` | `#0554a3` |
| `--tt-chart-2` | `#b85207` | `#883c04` |
| `--tt-chart-3` | `#1dcaf7` | `#0f91b2` |
| `--tt-chart-4` | `#bf3584` | `#980563` |
| `--tt-chart-5` | `#8054d6` | `#885ee0` |
| `--tt-chart-6` | `#c99414` | `#a07506` |
| `--tt-chart-other` | `#9e9e9e` | `#747474` |

The set was searched for and then checked with the data-visualisation palette validator. Against every built-in theme's canvas and surface the lowest contrast is 3.21:1 in dark (`--tt-chart-4`) and 3.10:1 in light (`--tt-chart-3`). Because lines cross and a model keeps its colour wherever it lands in a stack, every pair was checked, not only neighbours: the worst pair of hues is 9.8 apart in dark and 10.1 in light for protanopia and deuteranopia (Machado 2009, OKLab distance × 100, 8 being the target), and at least 15.4 apart with full colour vision. Other, the one colour with no hue, is at least 9.1 apart from every series for those readers and at least 12.1 with full colour vision. `themeTokens.test.ts` holds the contrast for every theme and mode and the separations for both modes. Tritanopia is not covered: orange and magenta come within 3.4 in dark. The value list names every series, stacked pieces are parted by a hairline of the room, and every value can be read from the keyboard, so colour is never the only way to tell series apart.

## Production Windows journey

`npm run build` passed. A new journey in `tests/e2e/usage-dashboard.spec.ts` writes synthetic Claude Code transcripts and a Codex CLI rollout under the fixture's own home (seven models, two providers, 209 prompts over fourteen days), launches production Electron main with the network off, waits for the real history importer to read them, and then on Prompts chooses By model, checks every series' total and Other (2), switches to Lines with the arrow keys, reads yesterday from the keyboard and checks the value list and the announcement, and goes back on Escape. The next Tab stop opens Each model's provider and what Other holds with Enter, checks its first line and Other's, and closes it on Escape with focus back on its summary. On Tokens it checks that the choice carried over, then draws By provider as bars. Every capture is checked for no horizontal overflow and for visible text at 4.5:1; reduced motion is on, as in the other Usage journeys. The [numeric evidence](../../artifacts/usage-chart-split/verified.json) records zero page errors.

| Capture | Size | Visible-text contrast minimum |
| --- | --- | --- |
| [Prompts by model, lines, a day read, dark](../../artifacts/usage-chart-split/prompts-by-model-lines-dark-1600.png) | 1600 × 1000 | 7.1:1 |
| [Prompts by model, bars, light](../../artifacts/usage-chart-split/prompts-by-model-bars-light-1280.png) | 1280 × 800 | 5.99:1 |
| [Prompts by model, lines, dark, at the minimum](../../artifacts/usage-chart-split/prompts-by-model-lines-dark-820.png) | 820 × 560 | 7.1:1 |
| [Tokens by provider, bars, light, at the minimum](../../artifacts/usage-chart-split/tokens-by-provider-bars-light-820.png) | 820 × 560 | 5.99:1 |
| [Each model's provider and what Other holds, open, dark, at the minimum](../../artifacts/usage-chart-split/prompts-by-model-providers-dark-820.png) | 820 × 560 | 7.1:1 |

All five were opened and looked at; they were taken again for the review fixes, so each now shows the disclosure's summary line under a chart split by model. At 820 × 560 the heading, Show and Bars | Lines still fit on one line; the head is a wrapping row, so a narrower room would put the controls under "Per day" rather than clip them. The value list falls to two columns and nothing clips, and the open disclosure wraps its last line under the chart. Usage is not in the design capture baselines, so none were regenerated.

Not checked here: the entrance animation with motion on, which still plays on the columns as a whole rather than on each stacked piece; the Mac and Linux desktops; a remote computer's filtered reads, which take the same path a model's details already do.

## Gates

`npm run typecheck`, `npm run lint` and `npm run notices:verify` (196 components) passed. The whole of `tests/e2e/usage-dashboard.spec.ts` passed, three journeys in 1.1 minutes, the two existing ones unchanged. The targeted unit and integration runs passed: the Usage, theme-token and series suites (9 files, 175 tests), the theme and appearance suites (12 files, 207 passed, 1 skipped, after the pinned `tokens.css` hash in `omarchyThemes.test.ts` was moved on purpose for the new tokens), and every suite that reads the guide, the ADRs, the verification notes, the Usage stylesheet or the ignore lists (22 files, 418 passed, 3 skipped).

For the review fixes, `npm run typecheck` and `npm run lint` passed, the Usage renderer, series, theme-token and native usage suites with the Muse and OpenCode usage integration suites passed (12 files, 199 tests), the artifact-ignore and evidence-document suites passed (2 files, 8 tests), and the whole of `tests/e2e/usage-dashboard.spec.ts` passed again, three journeys in 58 seconds.

The full `npm test` suite was not run on this computer; Zach asked for it to run on GitHub only. A run started before that request was stopped part way.
