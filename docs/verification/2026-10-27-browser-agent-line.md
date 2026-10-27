# Browser line verification

October 27, 2026, on `feat/browser-agent-line`, from `main` at d717248d with ADR-0154 and the `quiet-browser` Owl feature on top. Captured on Windows 11 in the built app (`npm run build`), with `tests/e2e/browser-agent-line.spec.ts` and `SOTTO_E2E_EVIDENCE=publish`. The spec turns the feature on through `SOTTO_OWL_FEATURES=quiet-browser=1`, opens the Workshop thread and plays a Claude Code turn through the e2e host: `npm run dev`, then nine calls to Sotto's browser named `mcp__sotto_browser__…` with their input as Claude Code reports it. The scroll failed, and the screenshot is still running. The captures are in `artifacts/browser-agent-line/`, each at 1280×800 and 820×560, dark and light.

## What the captures show

1. **Running** (`running-1280-dark.png`, `running-1280-light.png`, `running-820-dark.png`, `running-820-light.png`): under the agent's reply there is one line, "Browsing localhost:5173 · took a picture of the page", with a globe, a still accent dot and a chevron. There are no rows for the nine calls. The working line under it ("Combing the desert") holds only the command: its name is "Working, 1 step so far". At 820 the whole line still fits.
2. **Opened** (`expanded-1280-dark.png`, `expanded-1280-light.png`, `expanded-820-dark.png`, `expanded-820-light.png`): Enter on the line opens the nine steps in plain words under a hairline: Opened localhost:5173, Looked at the page, Could not scroll the page, Clicked in the page, Typed into the page twice, Pressed Enter, Looked at the page, Took a picture of the page. The step that failed has an alert icon and a muted warning colour: amber in dark, rust in light. Escape folds the list and leaves focus on the line.
3. **Moved on** (`finished-1280-dark.png`, `finished-1280-light.png`, `finished-820-dark.png`, `finished-820-light.png`): the screenshot completes and the turn goes on to an edit and `npm test`. The same line now reads "Browsed localhost:5173 · 9 steps", without the dot. After Bug Bot's review the settled line adds ", 1 did not finish" for the failed scroll, in the warning colour, and a stopped or unknown step says so instead of reading as done; all twelve captures were taken again with that wording on October 27 (`finished-1280-dark.png` reads "Browsed localhost:5173 · 9 steps, 1 did not finish").

## Checked in the spec

- The line updates in place: one `.thread-browser` element while the run goes on, and none of the tool rows.
- The line's name says what a press does: "Show browser steps: Browsing localhost:5173 · took a picture of the page", and "Hide browser steps: …" once open. The site is in its own left-to-right element (ADR-0123).
- The dot has no animation. Nothing blinks or pulses.
- With room for them, the line's words are whole, not cut short with an ellipsis. Nothing in the transcript is wider than the transcript at either size.
- Every step's words, the failed one included, and the line's last step meet 4.5:1 on dark and on light.
- Stable (`quiet-browser=0`) keeps today's view: no browser line, "Working, 10 steps so far", and a row for each call once opened.

The unit tests are `tests/unit/renderer/browserLine.test.ts`, for the fold and its words per provider naming, and `tests/unit/renderer/browserLineView.test.tsx`, for the transcript on Owl and on stable.

## After review

A review of the first commit changed the rules, not the look, so the captures stand. A turn now has one browser line wherever other work or replies fall between its calls. The line sits where the first call happened and lists every step in order. A reply written after the last call ends "Browsing" as other work does. A call made under a subagent keeps its row under that subagent rather than vanishing from the working line. Muse's calls, whose server name carries a suffix, get the line too. The transcript works out every turn's lines once for each set of records, not on every draw. The spec ran again on the rebuilt app and passed, with the new names and the site's own element checked.

## Found while capturing

The first captures cut the line's words short ("took a picture of the pa…") with room to spare. The line's -6px margin made a shrink-to-fit parent size it 6px narrower than its words. The lines now sit in a plain block, and the spec checks for the cut.

## Not checked here

- Codex and Grok Build in a live run. Their naming and Codex's answered task are covered by the unit tests only.
- macOS and Linux, and reduced motion. Nothing in the line moves, so reduced motion has nothing to hold still.
- The cloud iPhone line ("Using the cloud iPhone"), outside the unit tests.
- The composer's hourglass readout. It still names a held browser call by its tool name, such as `mcp__sotto_browser__browser_action`, when the call holds the turn for 20 seconds. That is outside this change.
