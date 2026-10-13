# Thinking as it streams

October 5, 2026. Issue #768, on `feat/show-thinking` from `main` at e8a82a03. Zach decided on October 5 that thinking
shows as the reasoning row Codex's reasoning summaries already use, with the live thinking text, not a new look; this
note shows that row in the running app.

## How it was run

`tests/e2e/thread-thinking.spec.ts` launches the built app's production main through
`tests/fixtures/nativeUsageElectronMain.cjs`, with the production Claude adapter driving the scripted Claude Code CLI
(`tests/fixtures/fakeClaudeThread.mjs`) in an owned temporary profile. It sends a prompt, then has the CLI stream a
thinking block the way Claude Code 2.1.289 does (start, thinking deltas, a signature delta, stop, then the reply)
and hold twice: halfway through the thinking, and between the thinking and the reply. The words are invented.

Halfway through the thinking the spec finds the row by its accessible name, *Thinking, Check the parser before the
test, Running*, with `data-kind="reasoning"` and `data-status="running"`, below the user's message, and checks that no
reply text is on screen. At each size it checks that the thread pane does not overflow sideways, then captures it.
When the block ends the row reads *completed* with all its words and opens to them, still before any reply. When the
reply arrives it sits below the row, and the thread goes idle.

## What the screenshots show

All in `artifacts/show-thinking/`, at 1600x1000, 1280x800 and 820x560:

- `thinking-dark-*.png`: mid-thought in the dark theme. The row has the brain icon, **Thinking**, the words so far as
  its preview, and the accent pulse with *Running* and its clock. The live line below it carries the wait in words,
  because the row directly above already names the action.
- `thinking-light-*.png`: the same in the light theme.
- `thinking-reduced-motion-*.png`: the same with Sotto's reduced motion on. A still capture cannot show movement, so it matches the dark one.
- `thinking-opened-dark-1280x800.png`: the finished block opened, its words set as the reasoning row sets a summary,
  with how long it took.

At 820x560 the pane header truncates the thread and folder names as it does for any thread; the row, its preview and
its status fit.

## What it does not show

The CLI here is scripted. No live Claude run was made, so the screenshots do not show what Claude Code's own stream
carries for a model that sends its thinking without words; the unit and integration tests cover that case
(`tests/unit/main/claudeThinking.test.ts`, `tests/integration/providerThinking.test.ts`), and the row then shows
without a preview. Grok and Devin threads draw the same row from their thought chunks; their integration tests check
the record, and one gated live Devin run checked that Devin streams them (see
`docs/perf/2026-10-05-thinking-first-sign.md`).
