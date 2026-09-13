# Phase 3 independent review

Reviewed baseline `bf500b42f91cfc1bd198c2d75d62ee48ef4232a8` through frozen implementation `7b0aec4847fd8e3f160c4017e170de8973fb1306`. Two independent gpt-6-astra/high CLI reviewers read the source and surrounding execution paths. These are source review findings; runtime reproduction and remediation are recorded separately below. All ten canonical tickets and the user's themes/icon/orb/widget requirements were included. The subsequent user request for Sotto's own theme names is an additional acceptance check.

## Standards

Two P2 findings:

1. Structured question selections and text existed only in a renderer Map, so unsent answers disappeared on restart. This violates CONTEXT's retained-draft requirement. Durable answer-draft implementation and verification are in progress.
2. Disabling personal-chat history discarded all decision records on disk, including reserved and uncertain answers. This violates ADR-0010's requirement to retain recovery identities and save intent before native writes. Fixed in 0c13e2b: redaction retains IDs/status while removing sensitive answer/request content. Six new regressions pass on main; the worker's 58 focused tests verify disk intent before dispatch, accepted/uncertain restart, privacy toggling and save-failure behavior.

No additional material smell-baseline findings. Standards total: 2; worst severity: P2.

## Spec

Three P2 findings:

1. A late Git list for an earlier activation could replace the active thread's watcher (#59 automatic refresh). Root reproduced this with an intentionally delayed first activation and fixed it in `1272b6e`. A neighboring regression also verifies that a replaced working folder moves the watch immediately. Both failed before the fix; all six Changes surface tests pass afterward.
2. Selecting Single row could force a fitting grid into compact mode and hide the sole arrangement switch (#54 returning to retained layout). Remediation and actual compact-to-grid verification are in progress.
3. Structured forms omitted the native request-level explanation/tool context when it differed from field descriptions (#52 complete questions with context). Remediation and rendered short-window verification are in progress.

No material unasked scope creep. Spec total: 3; worst severity: P2.

## Verification beyond source review

The initial independent Opus 5 workspace critic's three findings were corrected: native browser visibility beside a nonintersecting minimized editor, editor overlap with Send, and long personal failure diagnostics crowding the recovery action. Their ten integrated theme/branding/tool/recovery journeys pass on the isolated `7b0aec4` build. A further low-drag editor expansion correction is integrated as `a8a159b` and awaits final combined recapture.

The broad remaining Electron run passed 128 journeys with 21 existing opt-in/platform gates skipped, and exposed two stale expectations in `thread-workspace.spec.ts`: a provider-specific skill error and pre-theme fixed scrollbar color. Source inspection confirmed the intended behavior, the assertions were updated in `f4f5274`, and all four workspace journeys then passed. No product failure was hidden or skipped. The full initial Vitest checkpoint passed 3,184 tests with 15 existing gates skipped. Final verification after review corrections remains pending.

Final independent Opus 5 visual review and final delta reviews remain pending. Windows packaging must use the final isolated build; Mac and the separate #24 release gate remain unverified here. No remote changes or publication were made.
