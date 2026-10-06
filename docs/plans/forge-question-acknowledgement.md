# Forge question acknowledgement

User report: answers sent from the laptop reach agents on Forge, across multiple providers, but the desktop retains a delivery warning.

## Acceptance checks

- Reproduce accepted remote answers remaining unconfirmed through the real socket, desktop router and saved-answer service.
- Retire only the exact answer revision confirmed by its owning host; preserve newer drafts and unrelated hosts, threads and requests.
- Keep genuinely uncertain delivery recoverable. Never resend an answer or approve a request automatically.
- Preserve the existing question panel. A throwaway state demonstration covers confirmed, uncertain and late-confirmed answers.
- Verify focused regressions, repository gates and the existing Electron question and saved-answer journeys. Inspect their screenshots.
- State separately what was proved locally and what was exercised on a live Forge host.

## Current state

- [x] Clarified that multiple providers are affected.
- [x] Assigned independent GPT-6.1 Sol transport and regression agents.
- [x] Deterministic reproduction and causal probe.
- [x] Production fix and positive/negative regression coverage.
- [x] Review, documentation and local gates.
- [x] Real Electron verification and visual inspection.

The implementation is on `fix/forge-question-ack`, based on local `main` at `77d24f8d`. The original `chore/launch-video` checkout and its unrelated untracked artifacts are unchanged. No publish, install or live host restart has been performed.

The throwaway state demonstration is preserved on `prototype/forge-answer-receipt` at `4f81c4b4`, in `docs/prototypes/forge-answer-receipt-prototype.html`. It illustrates the existing question panel: only a receipt for the exact submission clears its saved answer. It makes no visual change to the shipped interface. The user clarified that the bug affects multiple providers; no new design choice was needed.

The regression first failed for accepted Codex, Claude and Grok answers. Additional red cases covered checking after both processes restart, a desktop detail-read failure after acceptance, a host provider-read failure after acceptance, and recovery after reconnect when the question is absent and the UI has no Check button. The fix preserves exact identity and digest matching throughout, including read-only background recovery. Older unbound drafts remain recoverable; they cannot be proved delivered retroactively.

The full suite passed 6,382 tests, the final remote-delivery/router run passed 33, and the real Electron journeys passed all 18. Typecheck, lint, dependency notices, build and both review axes passed. Screenshots and remaining live-host/platform limits are recorded in [the verification note](../verification/forge-question-acknowledgement.md).
