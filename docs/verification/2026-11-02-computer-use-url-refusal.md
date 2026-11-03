# Computer Use stops when Chrome hides the page's address

Issue #2062, November 2, 2026, on the Windows laptop. The report for OpenAI is `docs/research/2026-11-02-openai-computer-use-url-report.md`, which holds the full tables.

## What was proved in the real helper

A Terra worker ran `sky` and `cua_repl` against Chrome 156.0.8078.74 on a throwaway profile. Its only address was `example.com`, with host rules pointing it at a local test server for the dialog, large-page and slow-reload rounds. Results came from the helper itself, not a fake.

- With a JavaScript alert open, reads gave the exact refusal, 3 of 3. Reads in the same turn worked once the alert closed, so the helper does not hold the refusal for the turn.
- Moving to a 20,000-row page gave 7 refusals in about the first 700 ms, then none.
- A fresh Chrome, fast reloads, and clicks followed by idle gave none. A slow reload gave none in 231 reads, though plain polling saw the page's `document` node gone for about 50 ms.
- `click(<element>)` with no screenshot gave `coordinate input geometry is unavailable`. The same click worked after `getScreenshot()`.

## What was not proved

- **The Codex app.** Zach reports never seeing this in Codex. The helper's skill forbids automating the app, and Zach chose not to run the one-line test by hand. This laptop's 28 kept Codex app sessions never read a Chrome page through Computer Use, so they say nothing either way. Whether Codex avoids this by sending browser work through its Browser Use plugin is unknown, as is whether Sotto threads can reach that plugin.
- **The real page's state.** No tree exists from the moments of the original refusals, so what caused them is inference.

## What Sotto changes

- A failed Computer Use step with this stop now shows Sotto's explanation with the helper's words under it. Only a line starting with the helper's sentence counts, because a read's output holds the page's own words. A failure that is the call's whole, one-line output moves from the output block to under the explanation, which also applies to the sandbox and connection messages. Longer output stays in its block above.
- The Codex Computer use worker is told to take a screenshot before clicking an element by index, and to obey the URL stop and report what it left unchecked. This reaches workers started through Codex's own roles. It does not reach a thread started directly on Codex.

Sotto does not retry on the helper's stop or get around the check. A later request is checked again like any other.

## Checks

`tests/unit/main/codexComputerUse.test.ts` and `tests/unit/main/subagentRoles.test.ts` pass. So does `tests/e2e/computer-use-guidance.spec.ts` in the built app on this laptop, with a new journey for this stop: it opens from the keyboard and does not overflow at 820x560 (`artifacts/computer-use-url-refusal/820-560.png`, read by eye). That journey uses a saved failed step, so it shows the display and does not itself prove a live stop. CI's desktop smoke does not run this spec. Light appearance and the larger sizes were not rechecked for this stop; the step's layout is the one the connection journey checks at all of them.
