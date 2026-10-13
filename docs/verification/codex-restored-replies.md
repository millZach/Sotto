# Codex replies after restart

Verified on Windows, September 29, 2026, first against Sotto 0.1.24 and then with the final review fixes on the 0.1.26 base. The installed application was 0.1.24 and the native Codex client reported 0.159.0.

## Failure and cause

`npx vitest run tests/integration/codexStoredHistory.test.ts --maxWorkers=2` reproduced the report before the patch. Ten completed exchanges were saved through the real Codex adapter into `ThreadStore`. Restart replayed native `item_completed` user receipts. The newest ten-turn window then contained ten user messages and no assistant messages; the original ten replies remained in the database.

The native rollout contains `item_completed` entries with `item.client_id`; Sotto checked only the envelope's `client_id`. The watcher therefore publishes native message IDs while Sotto's stored user messages use their client IDs. `orderMessages` filtered corroborated aliases from the adapter's held messages but never changed the event-store projection. The renderer reads that projection. The update/restart exposed this mismatch; paginated history was observed but is not the demonstrated cause.

## Repair and checks

Codex now checks exact native identity and the message digest before publishing a rollout receipt. Already saved duplicates produce a `message-aliased` event. The store independently compares role, text, command identity and attachments before removing the duplicate from its projection. Events stay intact and a projection rebuild preserves the repair. Distinct native input with identical words remains visible and unowned.

A read-only SQLite connection backed up the affected local profile into a temporary directory. Applying the repair to that copy identified nine affected Codex threads and removed fifty duplicate receipts, with zero assistant replies removed. One opening window changed from zero to sixty-four assistant replies. The temporary copy was deleted; the original profile and installed app were not modified. No real conversation text was printed or retained as evidence.

- Initial regression coverage: 35 focused tests passed across six files. After review, 49 tests passed across the store/log/socket suites and 15 passed across the Codex identity suites (overlapping files). The final activity-anchor correction passed all 10 tests in the log and saved-history suites. Coverage includes both clean restart and previously saved duplicates, projection rebuild, same-text outside input, nested client IDs, conflicting client IDs, mismatched content/roles/command identity, and history redaction.
- Typecheck, lint, notices and production build passed.
- `npx playwright test tests/e2e/codex-restored-history.spec.ts` passed with the real adapter over the scripted Codex subprocess. It checks the reply remains visible and the user prompt appears once after reconnect and renderer reload.
- Visually inspected dark and light at 1280x800, minimum 820x560, and 1600x1000 with reduced motion. Windows display scaling makes the screenshot pixel dimensions larger than the window's logical dimensions. Captures: [dark](../../artifacts/codex-restored-replies/dark.png), [light](../../artifacts/codex-restored-replies/light.png), [minimum](../../artifacts/codex-restored-replies/minimum.png), [wide with reduced motion](../../artifacts/codex-restored-replies/wide-reduced-motion.png).
- Initial 0.1.24 `npm test -- --maxWorkers=2`: 6,250 passed, 151 skipped, one failed (472 files passed, 39 skipped, one failed). The sole failure was the Git-action fixture's initial `git push` to its temporary local bare repository: `unexpected disconnect while reading sideband packet`. It failed before exercising the assertion and passed in an isolated rerun. No Git-action code was changed. The full run is not reported as green.

A preliminary 0.1.26 full run finished with 6,311 passed, 152 skipped and three failures: an outdated benchmark method name, the in-progress anchor correction against a cached module, and a timeout in the Devin mode matrix. The benchmark wrapper was updated; the final anchor tests and isolated Devin test passed. A storage-failure regression also demonstrated stale identity evidence before the guard and passed afterward (19 tests across three suites). The final full run and CI results are recorded in the PR.

## Review and limits

[The two-axis review](codex-restored-replies-review.md) prompted shared saved-content validation, remote feature negotiation, conservative identity checks, and preservation of activity anchors. Standards review checked provider-owned identity, text-free operational logging, history privacy, authority preservation, event replay and the unchanged UI. Spec review checked the exact user-only window, existing affected records, restart/reload, and outside input. The new event does not reset a history epoch or grant authority. No model turn was sent to a real provider during diagnosis.

The native read-only protocol probe confirmed the sampled conversation still has assistant items. The [official App Server reference](https://learn.chatgpt.com/docs/app-server) describes `thread/read` and `thread/turns/list`; actual 0.159.0 behavior was checked locally because the reference's paginated-history limitation did not match the installed client's successful reads.

This verification did not package, install or release the fix. macOS was not tested. The native desktop inspection helper was unavailable, so visual verification used the rebuilt Electron application through Playwright with an isolated synthetic profile.


## iOS gate follow-up

The final desktop suite passed with 6,315 tests passed and 152 skipped; Windows and Linux CI passed. Two iOS CI attempts on `11091559` failed before test assertions in `XCUIApplication.launch()` on the large simulator. Both carried `DebuggerLLDB.DebuggerVersionStore.StoreError` and `no debugger version`. Every small-device test passed, and later large-device tests ran. This is a separate launch failure exposed while delivering the PR.

The next probe changes only the Test action's debugger/launcher selection. The normal Run action remains debuggable. XML parsing confirms the target remains enabled, and the complete macOS UI gate remains the runtime validation. The configuration follows [XcodeGen's test-action generation](https://github.com/yonaskolb/XcodeGen/blob/master/Sources/XcodeGenKit/SchemeGenerator.swift#L281-L282). The failure loop is `sh apps/ios/Scripts/verify-ui.sh` on the macOS runner; local Windows cannot execute Xcode, so this platform-bound check cannot be reduced to a local seconds-long loop. The PR records its outcome.

The next Windows run reproduced the Devin mode-matrix timeout previously seen on `main`: all six mode sends shared one 15-second test and kept their provider processes until fixture cleanup. The matrix now uses one case and fixture per mode, retaining every mode, assertion and the default deadline. This test-only correction leaves concurrent-thread coverage in its separate test. The PR records the final focused and CI results.
