# Storage notices and model catalog audit

Scope: the storage recovery and toast paths changed by [#1961](https://github.com/millZach/Sotto/pull/1961), and the cleanup catalog and presets changed by [#1960](https://github.com/millZach/Sotto/pull/1960). Compared against `origin/main` at `4108e81af6c66bce639cbbc47d4b1c7ee745c612`. Adjacent speech catalog and key-check code was read to identify actual duplicates. This is a source audit with isolated unit evidence; Sotto was not launched.

## Inventory and findings

| Area | Evidence and disposition |
| --- | --- |
| `RecoveryNoticeCenter` and paste permission recovery | `clear` retains suppression; `resolve` removes it only after a confirmed recovery. A dismissed cause remains eligible for the focus-triggered permission recheck. Existing tests cover visible and dismissed recovery followed by recurrence. Kept these semantics. Observer exceptions were silently isolated; they now emit `recovery-notice-listener-failed` and still allow later observers to run. |
| `ToastRegion`, `App.recoveryToast`, and `AppContext` | Both app layouts use the same toast mapper. A local dismissal suppresses an older snapshot, while an explicit `cleared: false` event allows a genuinely new permission failure. The dismissal IPC catch intentionally keeps a failed bridge reply from restoring an overlay. Subscription failure still has the retained-notice snapshot fallback. No proven behavioral fault; unchanged. |
| Storage repository wiring, `AtomicJsonStore`, and `strictJsonFile` | Both parse JSON, but their fallbacks are different contracts. The atomic store backs up corrupt data before returning defaults; the strict reader preserves unsafe-to-reset data and returns an unreadable verdict, including parsed raw data when available. Non-missing atomic-store I/O errors propagate. Recovery callbacks are intentionally best effort. No common loader extracted. |
| `SecureSettings`, `AgentCredentials`, and cleanup catalog wiring | Preset loading needed only the credential but used `forFormatting`, which also reads and parses `settings.json`. `formattingKey` now reuses the same decryption, unreadable-key notice, and original-error propagation without reading unrelated settings. The key is still read inside preset loading; failure still leaves the anonymous catalog available. Ciphertext is retained and decrypted keys are not cached. |
| Public models and presets | These requests already overlap. Their pagination, authentication, limits and partial-result behavior differ, so their load loops remain separate. Preset failures previously vanished into an empty list. Both paths now record fixed failure categories without upstream messages, keys or bodies. Return values and partial-page fallbacks are unchanged. |
| Speech models and zero-retention endpoints | Requests already overlapped, but their body reads were awaited sequentially. Both bodies now start together. Cache age, shared in-flight reads, privacy ranking and stale-list fallback are unchanged. Failed refreshes now log a fixed cause even when returning the last good list. |
| OpenRouter key check | Its timeout-versus-network classification was identical to both catalogs. All three now use [the existing key-check helper pattern in `networkReason`](../../src/main/llm/networkReason.ts), including cross-realm timeout names and the abort signal's reason. Key-check results are unchanged. |

## Consolidations and diagnostics

- [Shared timeout classification](../../src/main/llm/networkReason.ts) is used by [cleanup/presets](../../src/main/llm/openRouterModels.ts), [speech](../../src/main/llm/openRouterSpeechModels.ts) and [key checks](../../src/main/llm/openRouterKeyCheck.ts), replacing three copies.
- [Credential-only access](../../src/main/agents/secureSettings.ts) shares the existing notice and rethrow path with `forFormatting`; [the preset callback](../../src/main/index.ts) uses it.
- Catalog diagnostics distinguish HTTP, invalid response, network and timeout; presets also distinguish an unreadable key. The recovery center identifies an observer delivery failure. All are finite event names passed to main's existing operational logger. Raw exception messages and upstream response bodies remain excluded under the privacy contract.

## Reads and overlap

| Operation | Before | After | Evidence |
| --- | --- | --- | --- |
| `settings.json` reads per cleanup catalog call | 1 | 0 | `credentialStorage.test.ts` counts `AtomicJsonStore.read` calls with fixture credentials, first through the former `forFormatting` path and then through the catalog's credential-only callback. Both public and authenticated requests still run. |
| Additional credential-file reads per catalog call | 0 | 0 | `AgentCredentials.get` reads the already loaded ciphertext map; it still decrypts on access. |
| Catalog reads at service construction during startup | 0 | 0 | Cleanup loading is an IPC callback; the speech constructor only stores dependencies. Its first `list` call performs the requests. No startup timing improvement is claimed. |
| Speech response-body consumption | Sequential | Concurrent | A deferred first body proves the second body's `json` starts before the first finishes, without sleeps. No wall-clock benchmark is claimed. |

## Suspects left unchanged

- Main reads settings again for widget visibility, widget presentation and Dock presentation after `startupSettings` (`src/main/index.ts`, around lines 849–905). These are candidates for a broader startup snapshot contract. This audit did not prove that removing reads across the intervening asynchronous startup work preserves all settings visibility, so it does not change them or claim a whole-app read reduction.
- `SettingsRepository.readSettings` parses after `AtomicJsonStore` has parsed, and reset may reread settings to preserve held features and the speech model. Those paths also apply feature/default/theme projections; equivalence across those combinations was not established here. No validation or preservation logic was removed.
- A generic catalog loader and a shared JSON recovery loader would erase meaningful differences listed above. Similar-looking code is not sufficient evidence for either abstraction.
- Renderer subscription/snapshot failures remain quiet. They are separate transport failure paths; this audit found no reproduction of a lost recovery notice and adds no new renderer reporting or retry flow.

## Verification

Each file was run separately with Node 24.22.1, using `fnm exec --using 24.22.1 -- node node_modules/vitest/vitest.mjs run <file> --maxWorkers=1`:

| File under `tests/unit/main/` | Passed |
| --- | ---: |
| `openRouterModels.test.ts` | 19 |
| `credentialStorage.test.ts` | 15 |
| `openRouterSpeechModels.test.ts` | 11 |
| `recoveryNoticeCenter.test.ts` | 6 |
| `openRouterKeyCheck.test.ts` | 12 |
| `pastePermissionRecovery.test.ts` | 5 |
| Total | 68 |

The initial Node 25 attempt failed in shared test setup because `localStorage.clear` was unavailable. The same targeted files passed under CI's Node 24 version; no product workaround was added.

`fnm exec --using 24.22.1 -- npm run typecheck` and `fnm exec --using 24.22.1 -- npm run lint` passed. No full suite, Playwright, design capture, app launch, live service traffic or production credential access was used. No UI or interface strings changed. Source review checked both the repository rules and the requested scope.
