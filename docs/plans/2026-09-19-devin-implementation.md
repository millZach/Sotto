# Devin local provider implementation - issue 150

Status: implemented and pushed; all Windows validation passes. Independent Codex Standards and Spec reviews are complete; final validation of the review fixes passes. Verification is Windows-only for this PR; Zach deferred Mac verification on September 20 because no Mac is available.

## Scope and acceptance

Implement [issue 150](https://github.com/millZach/Sotto/issues/150) from base da44e95413adff7486e43ef4a07fe8689dd8d2b0 on feat/devin-local-provider. Preserve unrelated prototypes. Zach approved disclosed provider-side data policies, PR creation, review fixes, and a merge after all required checks are green.

- [x] Establish native Windows authentication, explicit decisions, session recovery, authored UUID reconciliation, and separately authored ACP input.
- [x] Record the privacy decision and observed native destinations in ADR-0017 and README.
- [x] Implement a dedicated bounded adapter through the existing host, history, and working-copy seams.
- [x] Pass the complete shared adapter contract without skips.
- [x] Add Devin to Providers and thread catalogs, disabled on upgrade; keep terminal/coordinator catalogs unchanged.
- [x] Pass the native Windows host journey: deny, exact allow, question, restart, cancel.
- [x] Complete final lifecycle and post-session policy regression checks.
- [x] Finish Electron captures and visual/keyboard review at 1600x1000, 1280x800, and 820x560, light/dark/reduced motion.
- [ ] Deferred by Zach: native Apple silicon verification; no Mac support claim.
- [x] Run full typecheck, lint, tests with two workers, and notices.
- [x] Complete Standards and Spec reviews. Zach approved Codex reviewers in place of the configured external Claude reviewer.
- [x] Commit and push only this work to feat/devin-local-provider.
- [ ] Create PR after independent review, resolve findings and CI, then merge when every required gate passes.

## Implementation decisions

See [native compatibility evidence](../verification/2026-09-19-devin-native-compatibility.md), [policy evidence](../verification/2026-09-19-devin-policy.md), and [ADR-0017](../adr/0017-devin-native-provider-data-policies.md). The native ACP Normal selector does not enforce approval in a Git project. Sotto instead pins the tested binary, confirms its owned ask profile, and refuses unverified native hooks, plugins, enabled MCP, project configuration, and altered settings.

A native session becomes durable with its first prompt. Only a confirmed, untouched empty thread after clean shutdown may renew its native handle; dispatched or ambiguous sessions cannot. UUID dispatch metadata is persisted before sending and reconciled through authoritative replay. No ambiguous mutation is resent.

Existing desktop provider and thread surfaces are retained. The provider grid fits four identities at desktop widths and two at narrow widths. Supported requests show the exact action once; scope validation retains the original action privately.

## Revised verification scope

On September 20 Zach confirmed that no Mac is available and directed this work to proceed with Windows only. Native Apple silicon verification is deferred and is no longer a pre-merge gate for this PR. The original issue/spec requested both platforms; this is the user-approved deviation. The Mac route remains unverified.

## Final Windows gates - September 20

Typecheck, lint, and notices pass (174 notice components). Full `npm test -- --maxWorkers=2`: 301 files passed, 17 skipped; 3,927 tests passed, 34 skipped, 343.29 seconds. Built Devin/provider-selection Electron specs passed 2 tests in 14.8 seconds. All 3 native Windows cases passed in 54.10 seconds. No PR or merge yet; independent Codex reviews are complete.

## Review fixes

Standards: one finding resolved by the explicit bounded native replay amendment to ADR-0016. Spec: two findings resolved by real Devin working-copy coverage and native abrupt-owner-loss checks. First-owner crash can lose the selected native model; the adapter refuses substitution and now reports actionable recovery instructions. A previously clean-saved session recovers under the same native ID. See the separate [review report](../verification/2026-09-20-devin-review.md). Final full-suite, native, and Electron checks of these fixes passed before PR creation.
