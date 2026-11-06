# Watcher's own question (#2228)

Zach picked **A · In the conversation** on November 5, 2026, from the prototype at the tag `prototype/watcher-audit-2026-11-05` (`docs/prototypes/watcher-own-question-prototype.html`). Watcher's question is Sotto's card where Watcher asked. It never holds Watcher's turn, it counts in the needs-you count, and once answered it gives way to one line with the user's choice. The decision is recorded in ADR-0073's amendment of November 5, 2026.

## Before and after

**Before:** [Watcher's own question as its provider's card](../../artifacts/watcher-card-queue/full-dark-1280.png), captured for #1813. It sits above Watcher's composer, and the composer says **Queued until you answer the card**: Watcher's turn waits on it, and so does everything queued behind it. This PR leaves that card as it was, for a question that still comes through a provider's own tool, so the earlier capture still shows today's look.

**After**, on the built app (Sotto Owl, `tests/e2e/watcher.spec.ts`, "Watcher's own question is a card where it asked that holds nothing…"):

| What | Dark | Light, reduced motion |
| --- | --- | --- |
| The card where Watcher asked, with news replies below it | [1600×1000](../../artifacts/watcher-own-question/own-question-card-dark-1600x1000.png), [1280×800](../../artifacts/watcher-own-question/own-question-card-dark-1280x800.png), [820×560](../../artifacts/watcher-own-question/own-question-card-dark-820x560.png) | [1280×800](../../artifacts/watcher-own-question/own-question-card-light-1280x800.png), [820×560](../../artifacts/watcher-own-question/own-question-card-light-820x560.png) |
| The needs-you list, with **Watcher asks** first | [1280×800](../../artifacts/watcher-own-question/own-question-needs-you-dark-1280x800.png) | [1280×800](../../artifacts/watcher-own-question/own-question-needs-you-light-1280x800.png) |
| **↑ Watcher's question** while the card is scrolled above | [1280×800](../../artifacts/watcher-own-question/own-question-mark-dark-1280x800.png) | [1280×800](../../artifacts/watcher-own-question/own-question-mark-light-1280x800.png) |
| Answered: **You answered: Settle it.** | [1280×800](../../artifacts/watcher-own-question/own-question-answered-dark-1280x800.png) | [1600×1000](../../artifacts/watcher-own-question/own-question-answered-light-1600x1000.png) |

The room's projection is seeded through the end-to-end stand-in (`src/renderer/src/e2e/watcherStandIn.ts`), as the other room journeys are, so these show the window on a fixed picture. In it, Watcher's conversation has seven news replies after the question, each a turn of its own. The journey checks:

- The card follows the reply in which Watcher asked and comes before the first news reply.
- Nothing waits above Watcher's composer.
- The count goes from three to two once the question is answered.
- The list's row goes to the card and focuses it, and Escape closes the list.
- The mark shows once the conversation is scrolled to its newest reply, and pressing it focuses the card.
- Nothing overflows or clips at 1600×1000, 1280×800 or 820×560.

Contrast for every text role on screen, read from the pixels beneath it, night scene included, is in [readings.json](../../artifacts/watcher-own-question/readings.json): the lowest is **6.15:1**, the **Watcher asks** reason in light is 6.16:1, and the mark is 10.43:1.

What happens behind a press is checked over real processes rather than in the window:

- `tests/integration/watcherOwnQuestion.test.ts` drives main's Watcher over the fake Codex app server. `ask_user` answers at once and leaves no request in Watcher's thread. The answer, sent as the window sends it, reaches Watcher as news in the user's own words, once. No provider hears it. A second press is refused. A settle question's Settle it agrees that one settle, and Keep watching agrees none.
- `tests/integration/watcherPhone.test.ts` pairs a phone over the socket. Watcher's question is on its page as the ordinary card. Its answer is refused without the answers grant, taken with it, and refused again once the question has been answered.
- `tests/integration/watcherOwnTools.test.ts` checks the launches: Watcher's Claude Code process starts with `--disallowedTools AskUserQuestion` and none of the AskUserQuestion instructions, and Watcher's Codex thread has `features.default_mode_request_user_input` off.

## Not checked here

- No Watcher run on a real provider. The flag is Claude Code's own (`claude --help` lists `--disallowedTools`), but I did not see a live Claude Code Watcher ask through `ask_user`. It is worth one look on Owl: ask Watcher something that needs a decision and see the card arrive while news keeps coming.
- The iPhone app was not built or run. Its Watcher page draws whatever request cards the computer lists for Watcher's thread, and the integration test drives that path over the socket. No Swift changed.
- Grok Build, Cursor and Muse were checked on their fake servers only (`tests/integration/watcherOwnTools.test.ts`): a question on Watcher's own thread is cancelled and shows no card. Their cancels were not seen on the real clients.

## Commands

- `npm ci --ignore-scripts`, then `node node_modules/electron/install.js` for the Electron binary the journey launches.
- `npm run typecheck` and `npm run lint` passed.
- `npm run i18n:extract`, with its catalogs committed. `tests/unit/shared/interfaceCatalogs.test.ts` passed.
- The targeted vitest files passed:
  - The new tests: `tests/unit/main/watcherQuestions.test.ts`, `tests/integration/watcherOwnQuestion.test.ts`.
  - Updated: `tests/unit/renderer/watcherAsks.test.tsx`, `tests/integration/watcherPhone.test.ts`, `tests/integration/watcherOwnTools.test.ts`, `tests/integration/watcherTools.test.ts`, `tests/integration/watcherSettleJudgment.test.ts`.
  - Unchanged, near the change: `tests/unit/main/watcherOwnChanges.test.ts`, `tests/integration/tellWatcher.test.ts`, `tests/unit/main/watcherWakeUp.test.ts`, `tests/unit/main/watcherAskPlacements.test.ts`, `tests/unit/main/hiddenWakeUpInvariants.test.ts`, `tests/unit/main/followupWakeTypes.test.ts`, `tests/integration/watcherHandover.test.ts`, `tests/integration/subagentRoles.test.ts`, `tests/integration/markdownLinkInstructions.test.ts`, `tests/integration/claudeAdapterSafety.test.ts`, `tests/integration/codexAdapterBoundary.test.ts`, `tests/unit/renderer/watcherView.test.tsx`.
  - Gates: `codeSizeBudget`, `zodSchemaSites`, `copySites`, `scaleTokens`, `themeTokens`.
- `npm run build`, then `SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/watcher.spec.ts -g "own question is a card"`: that one journey, both appearances. The full suite and the other Playwright specs are left to CI.

On the first runs, the layout check at 1280×800 caught a night-scene owl clipped for a moment after the window shrank from 1600×1000. The same seed opened at 1280×800 showed none, with or without the card. The check now polls until the page settles, as the room's other layout checks do.
