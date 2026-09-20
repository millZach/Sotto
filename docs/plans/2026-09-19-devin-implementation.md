# Devin local provider implementation ? issue 150

Status: implemented locally; final validation and review in progress. Native Apple silicon verification remains pending.

## Scope and acceptance

Implement [issue 150](https://github.com/millZach/Sotto/issues/150) from base da44e95413adff7486e43ef4a07fe8689dd8d2b0 on feat/devin-local-provider. Preserve unrelated prototypes. Zach approved disclosed provider-side data policies, PR creation, review fixes, and a merge after all required checks are green.

- [x] Establish native Windows authentication, explicit decisions, session recovery, authored UUID reconciliation, and separately authored ACP input.
- [x] Record the privacy decision and observed native destinations in ADR-0017 and README.
- [x] Implement a dedicated bounded adapter through the existing host, history, and working-copy seams.
- [x] Pass the complete shared adapter contract without skips.
- [x] Add Devin to Providers and thread catalogs, disabled on upgrade; keep terminal/coordinator catalogs unchanged.
- [x] Pass the native Windows host journey: deny, exact allow, question, restart, cancel.
- [x] Complete final lifecycle and post-session policy regression checks.
- [x] Finish Electron captures and visual/keyboard review at 1600?1000, 1280?800, and 820?560, light/dark/reduced motion.
- [ ] Run required native Apple silicon verification.
- [ ] Run full typecheck, lint, tests with two workers, and notices.
- [ ] Complete Standards and Spec reviews using the configured reviewer.
- [ ] Commit/push only this work, create PR, resolve review findings and CI, then merge when every required gate passes.

## Implementation decisions

See [native compatibility evidence](../verification/2026-09-19-devin-native-compatibility.md), [policy evidence](../verification/2026-09-19-devin-policy.md), and [ADR-0017](../adr/0017-devin-native-provider-data-policies.md). The native ACP Normal selector does not enforce approval in a Git project. Sotto instead pins the tested binary, confirms its owned ask profile, and refuses unverified native hooks, plugins, enabled MCP, project configuration, and altered settings.

A native session becomes durable with its first prompt. Only a confirmed, untouched empty thread after clean shutdown may renew its native handle; dispatched or ambiguous sessions cannot. UUID dispatch metadata is persisted before sending and reconciled through authoritative replay. No ambiguous mutation is resent.

Existing desktop provider and thread surfaces are retained. The provider grid fits four identities at desktop widths and two at narrow widths. Supported requests show the exact action once; scope validation retains the original action privately.

## Remaining external input

The user was asked whether an Apple silicon Mac can be accessed or whether they will run the prepared native verification there. No connection details or result have been received. This remains a merge gate under the approved specification, not a reason to stop independent implementation and PR preparation.
