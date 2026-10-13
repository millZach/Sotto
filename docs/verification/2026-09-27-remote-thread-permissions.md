# Paired-client thread permissions ? September 27, 2026

Issue #377, based on `7b5fdb843c46ca9fbd21d0ea6acc6656d7f72def`.

The coordinator checks the actual new-thread permission settings after it resolves host defaults and provider profiles. It uses the originating client's policy, before saving the dispatch intent and again before dispatch after that save. Explicit permission changes use the same check. A preference never creates a policy grant. This implements ADR-0004 and ADR-0025 without changing their decisions, the socket protocol, or any permission surface. The refusal reuses the socket's existing sentence.

## Automated evidence

`tests/integration/remoteThreadPermissions.test.ts` runs a real headless host, SQLite policy store, paired socket client and coordinator with scripted provider effects. Seven cases cover all three granting runtime modes, explicit and inherited choices, a first-listed provider profile that allows edits, an explicit profile that allows nothing, unset and asking defaults, desktop creation, per-client isolation, grant/revocation, and policy revocation while create/configure waits for its durable intent. Refused creation leaves no thread; returning a thread to asking remains allowed. The Linux `test:socket` gate includes this file.

A model-only change on an unstarted thread can discard incompatible permission fields. This does not inherit the host's new-thread default: the native adapters start unset modes on asking. In particular Devin's `modeOf(undefined)` selects its fixed `ask-first` profile, independently of the offered profile list's order. A new thread's first offered profile is resolved by the coordinator and checked by this fix.

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run notices:verify`: passed, 174 components.
- Focused socket/default/allow-list suite: 45 passed before the two late-revocation cases were added; the final permission file passes all 7 cases.
- `npm test -- --maxWorkers=2`: 438 files passed, 34 skipped; 5,737 tests passed, 126 skipped. Final run used the frozen implementation and tests.
- `npm run runtime:prepare` and `npm run build`: passed.

## Desktop evidence

Windows Electron, temporary test profiles, scripted providers; no paid native-provider runs or production data changes.

`host-identity.spec.ts`, `thread-creation.spec.ts` and `new-thread-settings.spec.ts` passed all 4 tests. They cover host-scoped identity/draft restoration, creation and sending, preserved failed drafts, editable project defaults, keyboard Escape/focus and terminal creation. Project settings were exercised at 1600?1000, 1280?800 and 820?560 in light and dark. `agents.spec.ts` passed all 6 coordinator/settings/voice-fixture journeys, including minimum-size behavior.

The original `daily-workspace.spec.ts` had 1 passed and 1 failed: its line 152 expects diff text while `greeting.txt` is collapsed. The audit reproduces that same failure at the base commit; issue #391 owns the test repair. A temporary copy adding the existing **Expand greeting.txt** press passed both complete journeys: mixed-provider threads, browser/terminal/tools, reviewed commit/publish, restart, draft and queue recovery. The copy was removed. No product change or baseline regeneration was made for this mismatch.

Visually inspected the generated project-default settings captures at minimum dark and full-size light. Their controls remain readable and usable; the minimum view scrolls vertically. The retained examples are [820?560 dark](../../artifacts/review-377/project-defaults-820-dark.png) and [1600?1000 light](../../artifacts/review-377/project-defaults-1600-light.png). This fix changes no renderer code or layout. Unrelated tracked captures and generated runtime assets were restored.

## Neighboring work counts

`SOTTO_PERF_BENCH=1 npx vitest run tests/perf/threadSettings.perf.test.ts --maxWorkers=1 --disable-console-intercept`: 2 passed. Median counts over five presses match the existing [settings path baseline](../perf/2026-09-25-settings-light-path.md):

| Path | Thread reads | Coordinator writes | Alias writes | Session starts |
| --- | ---: | ---: | ---: | ---: |
| Claude, running, in-place modes | 0 | 1 | 1 | 0 |
| Claude, running, Full access transitions | 0 | 1 | 1 | 1 |
| Claude, reaped | 0 | 1 | 1 | 1 |
| Codex, running | 0 | 1 | 2 | 0 |
| Codex, reaped | 0 | 1 | 3 | 1 |

These are structural regression checks. Concurrent test suites were running, so their wall-clock timings are not performance evidence. The new guard reads the resolved options, model profile list and policy only; it adds no provider or history read.

## Independent review

A separate native GPT-6-astra worker reviewed Standards and Spec independently against the pinned base and #377: zero verified findings on either axis. Its model-switch question was resolved by inspecting the adapters' asking defaults; its suggested held-outbox revocation coverage was added and passed. Root performs a separate integrated review.

The skill-prescribed external GPT-6-astra standards/spec attempts could not inspect files because the Windows sandbox failed initialization. The Grok 4.7 attempts returned no report and were stopped when root selected native cross-review instead. These attempts are not counted as completed reviews. macOS and live-provider compatibility were not tested by this Windows patch.
