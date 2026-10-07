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
- [x] Integrate current `main` at `febe51a6` and preserve its command-local outcomes and shared host receipts.
- [x] Fix the final review's late native acceptance case after a negative receipt was already cached, including its stale delivery banner.
- [x] Repeat the final local gates and both review axes.
- [x] Address all four PR review findings and repeat both review axes, including real desktop Check and refusal/retry regressions.
- [x] Reproduce and fix the subsequent receipt-reply banner finding with unit and real Electron reconnect regressions that do not read the shell to hide it.
- [x] Distinguish accepted Check results from missing editable drafts, preserve captured acceptance through reconciliation, and ignore stale renderer replies without re-saving delivered answers.
- [x] Preserve bounded acceptance metadata after background retirement and update mounted question panels without another Check; protect Codex request identity across restart and detach confirmed listeners.
- [x] Integrate current `main` at `3bc5efa1` and replace four one-second host-connection polls with the repository's standard polling deadline after reproducing their CI failures.
- [x] Preserve Check for actual Claude/Grok re-asks, reach the provider through explicit remote recovery, protect pending writes, and version the saved-answer format; repeat both review axes and all 27 Electron journeys.
- [ ] Finish the complete local two-worker gate on frozen source; record the result on PR #796.
- [x] Resolve the final Check findings: independent threads, safe remote refusal guidance, and exact confirmation arriving during Check; protect queued direct, local/remote Send and voice answers, and repeat focused tests and both independent review axes.
- [ ] Confirm all required gates and resolved review comments on the published revision, then merge PR #796.

The implementation is on `fix/forge-question-ack`, originally based on local `main` at `77d24f8d` and now integrated with `main` at `3bc5efa1`. The original `chore/launch-video` checkout and its unrelated untracked artifacts are unchanged. The user authorized opening a PR and merging after checks and comments are resolved. No install or live host restart is part of that delivery.

The throwaway state demonstration is preserved on `prototype/forge-answer-receipt` at `4f81c4b4`, in `docs/prototypes/forge-answer-receipt-prototype.html`. It illustrates the existing question panel: only a receipt for the exact submission clears its saved answer. It makes no visual change to the shipped interface. The user clarified that the bug affects multiple providers; no new design choice was needed.

The regression first failed for accepted Codex, Claude and Grok answers. Additional red cases covered checking after both processes restart, a desktop detail-read failure after acceptance, a host provider-read failure after acceptance, and recovery after reconnect when the question is absent and the UI has no Check button. The fix preserves exact identity and digest matching throughout, including read-only background recovery. Older unbound drafts remain recoverable; they cannot be proved delivered retroactively.

The final specification review reproduced a late Claude callback recording acceptance after both the question and busy state had settled. A cached negative result kept the saved warning visible, and a separate notice could retain its delivery error. Exact acceptance now reaches the desktop without another read and retires both surfaces while preserving genuine uncertainty and newer notices.

The initial source at `f516eb06` passed 7,910 tests with 166 skipped, all 20 Electron journeys, typecheck, lint, dependency notices and build. PR review then found four additional recovery defects: exact Check routing, optional receipt failures after acknowledgement, one host stalling other owners, and receipt notifications clearing unrelated shell errors. Their fixes pass focused regressions, both review axes, all 22 Electron journeys, typecheck, lint, notices and build. The complete two-worker suite is repeated with source and tests frozen; its final result and the published revision's GitHub gates are recorded on [PR #796](https://github.com/millZach/Sotto/pull/796) before merge. Screenshots and remaining live-host/platform limits are recorded in [the verification note](../verification/forge-question-acknowledgement.md).
