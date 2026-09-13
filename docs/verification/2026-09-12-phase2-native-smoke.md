# Integrated Phase 2 installed Codex smoke

Result: **not accepted** at `bfefea2`. Actual installed execution found an automatic queue dispatch failure and historical message identity loss on reconnect. No production source fixes are included in this verification change.

Executed September 12, 2026, Pacific time (September 13 UTC). Production main/preload/bridge built from this worktree; installed Codex 0.154.0; catalog-selected GPT-5.6-Luna with supported `low` reasoning. No Sotto E2E provider mock was enabled. `window.sottoE2E` was absent.

## Native evidence

| Check | Actual result |
|---|---|
| Native execution budget | **2** `turn/start` requests, both accepted; **1** accepted `turn/steer`; **0** interrupts; one newly created native thread |
| Skill discovery | Native `skills/list` returned the unique committed synthetic project skill for the independent worktree cwd |
| Structured invocation | Exact `{type:'skill', name, path}` accompanied unchanged text on original send, steer, and subsequent queued dispatch |
| Worktree | Production thread creation allocated an independent Git branch/checkout under the isolated profile; native `thread/start`, `turn/start`, and `thread/resume` used it |
| Real tool work | One native shell command ran the synthetic proof script, wrote its unique nonce and actual cwd, waited 10 seconds, exited 0, and reported both wait markers |
| Source isolation | Nonce matches the committed script; proof cwd matches the independent checkout. Original synthetic project remains Git-clean and has no proof file |
| Steering | Acknowledged the same active native turn; final answer was `STEER_APPLIED`; no cancellation/new-turn fallback |
| Automatic queue | **Failed.** Enqueued while running, remained paused even after native completed outcome; no second dispatch during the 75-second bounded wait |
| Reviewed queue recovery | After verifying the item had no message ID and no corresponding native start, one explicit `resume-followups` dispatched the existing item once; reply `QUEUED_DONE` |
| Reconnect/replay | Repeated production app restarts resumed the same native session; unchanged turn-start/steer counts, preserved cwd and activity IDs, no tool rerun |
| Historical messages | **Failed.** First restart replaced 3 of 4 message IDs, including the steer user message; that message also lost its Sotto command ID. Later restart replaced the queued turn's assistant ID |

Sanitized session hash: `d710650e85825707`. First turn hash: `41fdc3f0a5b2163a`; subsequent turn: `1f87a953a12a9445`. Hashes use the first 16 hexadecimal SHA-256 characters. Native identifiers, auth files and private catalog contents are not included here.

## Findings for the integrating parent

### Queue pauses on the status/completion boundary

The first live turn completed its actual tool and final reply, but the queued item retained:

> The last turn did not confirm completion. Review the thread and resume queued follow-ups when ready.

The first observer did not record `thread/status/changed`, so its exact ordering is not directly retained for that turn. The observer was extended before the subsequent existing-queue dispatch. That actual turn produced, in wire order at timestamp `1789271722978`:

1. `thread/status/changed`, status `idle`.
2. `turn/completed`, status `completed`.

The source explanation is supported by a separate deterministic controller fixture: start with thread status/lastTurn both running, enqueue, publish idle with lastTurn still running, then publish same-turn completion. The item becomes paused and no send occurs. The diagnostic assertion expected one send and received zero. The temporary diagnostic was removed after recording this result; existing tests were restored exactly.

Relevant paths: `src/main/agents/codex.ts` status notification mapping and `src/main/agents/control.ts` `pumpFollowups`/`terminalBlocked`. Proposed fix: preserve the distinction between an idle status notification and an authoritative terminal outcome. Wait for completion while the last turn is still running; retain explicit interruption/failure/unknown recovery gates. Do not automatically resume every paused item.

### Native history item IDs replace live IDs

On native resume, two assistant messages and the steered user message used history-generated `item-*` IDs instead of their live IDs. Their text remained present once. The first original user message retained its Sotto identity; the steer did not retain its `commandId`. The next queued user message also retained its identity, while its assistant reply changed ID on restart.

Relevant paths: `src/main/agents/codex.ts` `applyThread`/`applyItem`, persisted `origins`, and `src/main/agents/workspace.ts` snapshot reconciliation. `applyItem`'s digest fallback considers only origins without an existing `itemId`; a steer origin already associated with its live item is therefore not remapped to the historical item. Assistant messages have no equivalent persisted Sotto identity mapping.

Proposed fix: reconcile authoritative history against stable local message identities using native client identity where available and a bounded, unambiguous turn/order/text mapping where it is not. Preserve command origins and message anchors; never deduplicate repeated identical messages by text alone. Add fixtures whose live and resumed item IDs differ, including a same-turn steer and repeated text.

## Checks actually run

- `npm run build`: passed. No install/package/release.
- `npm run runtime:verify`: initially failed with `unexpected runtime files`; passed after restoring four existing SHA-256-verified assets. The worktree lacked ignored WASM payloads and the checked-out JS wrappers had CRLF byte differences. No runtime source content change is included.
- Five existing fixture files: **37 passed** (`codexSkills`, `followups`, `nativeSteering`, `codexActivity`, `threadWorktreesNative`, `--maxWorkers=2`). These are fixture results, not installed-model execution.
- Temporary queue ordering diagnostic: **1 failed**, expected 1 send / received 0; 12 unrelated tests skipped. This supplies a deterministic explanation for the live queue failure.
- `native-phase2-live.spec.ts`: actual execution **failed** the automatic queue completion criterion after the first accepted native turn and steer.
- `native-phase2-recovery.spec.ts`: actual execution completed reviewed queued dispatch and both reconnect checks, but **failed** the message-identity assertions. Soft identity assertions allow the independent no-replay checks to finish and do not mark the result passed.
- Node/web typecheck and changed-file ESLint passed. Both native tests skip without explicit opt-in.
- The recovered Electron screenshot was visually inspected: both synthetic final replies and the one project/thread are visible. This is backend bridge verification, not full composer/picker/worktree UI acceptance. The retained composer contains the previously submitted steering text in this bridge-driven journey; the parent should assess that through its actual UI journey.

Two preliminary test runs initiated zero turns: the missing runtime-assets launch and an overly narrow `mini` catalog filter. Read-only startup/model diagnostics also initiated zero turns. No accepted work was retried. All application profiles, project files, proof files, and screenshots were created under owned direct-child `sotto-e2e-native-*` temp roots. Existing installed auth was used only through the production adapter. No global provider/account/skill settings were changed, no user repo/native thread was targeted, and no temp root was recursively deleted.

## Reusable opt-in tests

Build and verify existing runtime assets first. A fresh smoke creates one new synthetic project and normally spends two native turns plus one steer. It deliberately fails if queue or identity acceptance is not met. It does not silently resume a failed queue.

```powershell
npm run runtime:verify
npm run build
$env:SOTTO_NATIVE_PHASE2_LIVE='1'
npx playwright test tests/e2e/native-phase2-live.spec.ts --workers=1 --retries=0
```

To inspect only an existing owned root, set `SOTTO_NATIVE_PHASE2_RECOVERY_ROOT` to the printed root and run `native-phase2-recovery.spec.ts`. This does not send a prompt. The fresh smoke skips when recovery mode is selected. Only an explicitly reviewed, known-unsent paused queue can be resumed by also setting `SOTTO_NATIVE_PHASE2_RESUME_QUEUED=1`; a durable exclusive-create marker prevents a second resume attempt even if acknowledgement is lost. Never re-run the fresh smoke to recover accepted work.

The observational launcher forwards all installed-provider bytes unchanged. Its persisted wire projection contains only selected method names, statuses, hashed identities, and synthetic relative paths/skill references. Artifacts remain in the owned temp root rather than the repository.
