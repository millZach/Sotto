# Cleanup settlement without copying histories

Based on `origin/main` at `0b0145a7`. This independent follow-up preserves PR #330. It removes unnecessary workspace snapshot materialization by the cleanup subscriber; it does not prove end-to-end composer latency.

A real WorkspaceHost with cleanup listening called workspaceSnapshot twice across cleanup startup and one provider publication while every cleanup rule was off. The regression now observes zero calls in that scenario. An explicit full snapshot still includes the retained message. Cleanup subscribes to settled thread IDs, derived with the existing thread/project settlement helper; older test hosts keep the full-snapshot subscription fallback.

The observer reports initial settlement and later publications, including project inheritance and restored/re-settled threads, and stops after unsubscribe. Actual sweeps, settings, reclamation guards and permission behavior are unchanged. The parent reviewed the final production split against standards and the requested bug and found no issues.

## Verification

At commit `183a4ab7`, targeted publication and cleanup suites passed: 2 files, 14 tests. Typecheck, lint and third-party notices passed (174 components). Build passed. The relevant built Electron reclaim and settled-folder journeys passed: 2 tests in 23.5 seconds. They cover reclaim on settle, retained branches, recreation on next send and a newly opened thread restoring only its folder. `npm test -- --maxWorkers=2` passed: 544 files passed, 40 skipped; 7,430 tests passed, 156 skipped, in 996.55 seconds. Production and unit-test source stayed fixed throughout that run.

Synthetic Windows verification does not establish installed-profile latency; macOS was not tested. Existing evidence captures are preserved around Electron execution and no appearance baselines are regenerated. The independent browser window-resize blank-page issue remains outside this change.

## Review follow-up: seed existing settlement once

PR #747 review found that the metadata observer treated its immediate delivery of already settled IDs as newly settled work. With on-settle cleanup enabled, start requested cleanup twice; its existing request coalescing made this harmless, but it differed from the fallback subscription's seed-then-listen behavior.

The first metadata delivery now seeds the existing settled IDs without requesting cleanup. Start still requests its normal initial sweep; later deliveries retain the settlement transition checks. The real WorkspaceHost regression spies before start: it failed before the fix with two calls instead of one, then passed with the fix. The later restore, re-settle, project inheritance and unsubscribe assertions stay unchanged.

Follow-up verification: the publication and cleanup suites passed again, 2 files and 14 tests. Typecheck and lint passed for this follow-up. The parent reviewed the final fix against standards and the requested finding and found no issues. The earlier full-suite and Electron results above belong to `183a4ab7`; this initialization-only review fix relies on its targeted regression and the final PR CI rerun rather than claiming a new local full-suite or Electron run.
