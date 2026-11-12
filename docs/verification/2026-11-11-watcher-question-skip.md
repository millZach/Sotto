# Skipping Watcher's own question (#2477)

Zach could not skip a question Watcher asks with `ask_user`. A watched thread's card has offered Skip since ADR-0135; Watcher's own card (#2228) was built without `skippable`.

**Before**: the card offered its choices and **Send answer** only (`artifacts/watcher-own-question/own-question-card-dark-1280x800.png`, from #2269).

**After**, on the built app (Sotto Owl on Linux under xvfb, `tests/e2e/watcher.spec.ts`, "Watcher's own question is a card where it asked that holds nothing, counts in Needs you and gives way to the user's choice or skip"):

- The card offers **Skip question** beside **Send answer**, the same control and words a thread's card has. No new look.
  - `artifacts/watcher-own-question/own-question-skip-card-dark-1280x800.png`
  - `artifacts/watcher-own-question/own-question-skip-card-light-1280x800.png` (reduced motion)
  - `artifacts/watcher-own-question/own-question-skip-card-dark-820x560.png`
- A skipped question gives way to one line, **You skipped this question.**, where the card was. Needs you drops to the two threads that still wait.
  - `artifacts/watcher-own-question/own-question-skipped-dark-1280x800.png`
  - `artifacts/watcher-own-question/own-question-skipped-light-1280x800.png` (reduced motion)
  - `artifacts/watcher-own-question/own-question-skipped-dark-820x560.png`
- Nothing overflows or clips at 1600x1000, 1280x800 or 820x560 in either appearance. The lowest text contrast on those pages is 6.15:1.

The journey seeds Watcher's room, so it proves the card and the line, not the press through main. The press is proven over the real coordinator in `tests/integration/watcherOwnQuestion.test.ts`: the skip marks the question `skipped` with no choice, no provider hears it, a later choice is refused as no longer waiting, and Watcher's next news says "The user skipped your question … on its card and gave no answer." and "Do not ask it again." `tests/integration/watcherPhone.test.ts` proves the phone's half: the card reaches the phone with `skippable`, and the skip the iPhone sends for it (SottoCore's `skipped: true`) is taken as the user's, under the answers grant.

## How

- `npm run build`, then `SOTTO_E2E_EVIDENCE=publish xvfb-run -a -s "-screen 0 1920x1200x24" npx playwright test tests/e2e/watcher.spec.ts -g "own question is a card"`: 1 passed, both appearances.
- The journey wrote every capture again. #2269's own captures were put back as they were, and only the six above were kept. The three `own-question-skip-card-*` files are that run's `own-question-card-*` captures under new names.

## Not checked here

- Windows and macOS: the card is the same component on each. CI loads this spec (`e2e:list`) but does not run its journey, so it was run on Linux only.
- The iPhone: the phone already draws **Skip** for any `skippable` card (ADR-0135). No Swift changed, so this needs a hand check on a real iPhone.
- A live provider: Watcher acting on the skip news was proven over the fake provider, not on Claude Code or Codex.
