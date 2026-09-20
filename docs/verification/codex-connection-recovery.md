# Codex connection recovery

September 19, 2026. Reproduced on Sotto 0.1.8 with installed Codex 0.155.1.

## Cause and acceptance checks

- The direct trigger was moving an already-loaded Codex thread from High to Ultra. Sotto sent the new effort through `thread/resume`, which returns the loaded session's existing settings instead of applying the change. A native thread with no first turn also has no rollout for that resume request.
- Use `thread/settings/update` and wait for its acknowledgement and matching `thread/settings/updated` values. Native Codex 0.155.1 passed High → Ultra → High → Ultra on GPT-6-Astra with both approval-required and Auto permissions. These two live tests send no model turn.
- A saved alias carried an unfinished reasoning-effort change. Native `thread/resume` reported settings that did not match `pendingSettings`.
- `applySettings` threw a normal error, and the shared RPC handler treated it as a transport failure and killed the App Server. Watched threads surfaced “Codex response could not be applied”; background reconciliation returned a disconnected snapshot.
- A fresh profile connected successfully. A temporary copy of the installed registries reproduced the failure. No prompt or raw provider response was logged.
- The fix keeps valid settings mismatches local to the affected thread, retains the unresolved intent, and reads native history and running state. Sends remain blocked until an explicit settings choice is confirmed. No reconnect request replays permission overrides.
- Recovery is tested through `AgentControl.command`, including watched and unwatched threads, an unrelated usable thread, and a rejected replacement that preserves the earlier intent.
- The native-accurate fixture also exposed a reconnect ordering bug: metadata-only resume published buffered legacy input before a full history read could corroborate its identity. Resume now leaves those rows buffered until history reconciliation; genuinely external input and failed reads still stop management for review.

## Installed recovery

With the user's explicit approval, backed up `codex-threads.json`, stopped installed Sotto, removed only the one `pendingSettings` field, and restarted the same installed 0.1.8 executable. The thread kept its last confirmed settings. No conversation was removed and no prompt was sent.

Visually inspected Settings > Providers after restart: Codex 0.155.1, Claude Code and Grok Build all showed Connected, with no Codex error. Screenshot: `artifacts/codex-connection-recovery/installed-connected.png`.

The recovery above used the unchanged installed 0.1.8 binary. Changing High to Ultra in that binary reproduced the failure again, which led to the dedicated settings-command fix. The installed recovery is distinct from the permanent source fix on `fix/codex-settings-reconnect`, verified separately below.

## Validation

- Final full gate: `npm test -- --maxWorkers=2` passed all 3,843 tests, with 31 opt-in tests skipped (294 files passed, 16 skipped). Typecheck, lint, notices, the built provider-settings Playwright test, and both live native settings cases also passed on the final source.

- The two new fixture cases failed before the fix, including the exact reported error for a watched thread.
- Native connection probe passed with a temporary copy of all four saved aliases, including the unresolved settings change. It connected, listed models and read every thread without sending a turn.
- A later repeat after restarting the installed app reached connection but Codex rejected a thread resume with an active-session error. The native all-thread probe therefore requires idle sessions; the earlier successful check and installed Connected screen are separate evidence. No active session was interrupted for the repeat.
- Initial targeted run: 63 tests passed across `codexHost.test.ts`, `codexImages.test.ts`, and `threadWorktreesNative.test.ts`. After adding the native settings command, all 50 Codex host tests passed, including notification-before-acknowledgement, notification-after-acknowledgement, and missing-notification cases.
- Both opt-in native settings tests passed against Codex 0.155.1, confirming High to Ultra to High to Ultra with approval-required and Auto permissions while remaining connected.
- Typecheck, lint, notices verification (174 components), build, and `native-provider-selection.spec.ts` passed.
- Full `npm test -- --maxWorkers=2`: 3,839 passed, 29 skipped, one failed. The failure was the Grok concurrent-worktree test observing an undefined working directory. Its entire 10-test file passed in the targeted rerun above, with no Grok or worktree code changes. That initial run was not green; the final complete rerun above passed without Grok or worktree implementation changes.
- A separate reviewer identified coordinator preflight and rejected-replacement recovery gaps; both were corrected and covered by the regression.
- The release-preparation full run hit a separate focus assertion in `threadOptions.test.tsx`: it checked focus after the DOM became enabled but before React's passive focus effect ran. Resolving the deferred save inside async `act` now flushes both before the assertion; all 16 tests in that file pass. The final full-suite result above includes this correction.
- A later full run passed 3,842 tests and skipped 31, but failed the legacy identity reconnect case. That failure reproduced in isolation and was fixed by deferring buffered rollout publication until history corroboration. All 67 targeted host, identity-review, message-identity, and session-log tests then passed. Neither identity expectation was weakened: own input preserves management and external input stops it.

No paid coding turn was used to verify this fix. Light/dark design captures were not regenerated because no layout or styling changed.
