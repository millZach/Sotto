# Skip each question

What was checked on November 6, 2026, for the Skip on each question of a question card (ADR-0135, November 6 amendment;
Zach's pick, variant A with Skip the rest, from `docs/prototypes/skip-each-question-prototype.html`).

## In the running app

`tests/e2e/skip-each-question.spec.ts` ran once on forge (Linux, `xvfb-run`) against `npm run build`, with
`SOTTO_E2E_EVIDENCE=publish`. The E2E host puts a Claude Code-shaped request with three questions on the Workshop thread. The
spec answers the first with **Wait for the rewrite**, presses **Skip the rest**, and checks that both other questions fold to
"Skipped." and that the footer reads "Ready to send · 2 skipped". It checks that nothing overflows the card at 1600 × 1000,
1280 × 800 and the 820 × 560 minimum, in light and dark. It then brings one question back with **Answer it** and skips it again,
which leaves focus on **Answer it**. Last, it sends with **Send answers** and checks the request has left the thread.

- `artifacts/skip-each-question/card-1280x800-dark.png`: the card as it arrives. Each question has a quiet **Skip** at the end
  of its top line, and **Skip the rest** is not there yet.
- `artifacts/skip-each-question/skipped-1280x800-dark.png` and `skipped-1280x800-light.png`: one answer and two skipped
  questions, each folded to "Skipped. Claude Code will use its own judgement." with **Answer it**, above **Skip questions** and
  **Send answers**.
- `artifacts/skip-each-question/skipped-820x560-light.png`: the same at the window's minimum. A long question's **Skip** wraps
  to its own line under the question and stays in reach.

What each provider is sent is checked in the unit suite, not here: the E2E host takes any answer.
`tests/unit/main/questionSkipEach.test.ts` covers Claude Code, Codex (its questions and its tools' forms), Cursor, Grok Build,
Muse, Devin and OpenCode, and the forms' required fields that have no Skip of their own.

## Not checked here

- The iPhone sheet. forge can only syntax-check Swift. The PR's macOS job compiles the app and runs SottoCore's tests, which
  include `testSkippedQuestionsGoAsTheirOwnAnswerShape`. How the sheet looks and feels is Zach's hand test on his iPhone.
- A live provider. No live Claude Code, Codex, Grok Build, Muse, Cursor, Devin or OpenCode thread was asked several questions.
  That each one goes on after a skipped question, and reads the skip sentence, comes from their protocols and is not proven
  live.
