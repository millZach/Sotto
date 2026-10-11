# Watcher thread tools, October 11, 2026

Windows x64, `feat/watcher-thread-tools`, based on `da18a1dc2`. The final implementation tested and built is `05a9bec66`. The later evidence commit changes only this note. Work stayed in the supplied worktree; `npm ci` ran first and succeeded with this worktree's own dependencies. No push, merge, rebase, stash, branch switch, new worktree, publication, additional installation or renderer edit ran.

## Contract and behavior

`768a3ab2b` committed the room contract before implementation. `src/shared/watcherRoom.ts` and the optional `window.sotto.watcher` bridge retain their channel names and request/result envelopes. The shared contract description is in the lead's `.zstack/watcher/contract.md`; its top records the optional text-free continuation, stop, native-head and creation-uncertainty fields.

Main owns current creation/recovery, the local nine-tool `sotto_threads` server, request scopes, capacity and four-prompt budgets, retries, takeover and receipts. Commands reuse the coordinator's lanes, queue and outbox with explicit host/Sotto thread identities. Machine guards run after native preparation and immediately before the writer. No tool can answer, grant or widen a worker request. Read cursors, activities and native project/working-copy choices use existing stores and native launch profiles. Selection and the user's Finished unread marks do not change.

Provider replacement waits for worker slots, native master work, active invocations and outstanding delivery. Same-choice opening succeeds while busy. Explicit user Queue retains its original executed request, including after Stop all; before a first Send it refuses. Targeted Stop and confirmed Stop all cancel only machine-owned undispatched messages. User queues remain intact and wait for review. Uncertainty survives takeover, and definitive unwritten failures refund their prompt budget.

With the gate off, the bridge/channels/service/tools are absent, ordinary actions work and dormant records remain whole. Owl with Run the local host off returns a plain refusal without changing the limit. Text-free native message heads let Owl detect a direct instruction made during a stable session.

## Gates

These commands ran in the required order against the final implementation, with real output.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Exit 0; all four TypeScript projects |
| `npm run lint` | Exit 0 |
| `npm test -- --maxWorkers=2` | Exit 0; 771 files passed, 58 skipped; 9,511 tests passed, 280 skipped; 1,029.76 seconds |
| `npm run notices:verify` | Exit 0; 189 third-party notice components |
| `npm run build` | Exit 0; main, host, preload and renderer |
| `npx playwright test tests/e2e/watcher-gate.spec.ts` | Exit 0; three journeys passed in 11.8 seconds |
| Opt-in `watcherThreadToolsLive.test.ts`, `--maxWorkers=2` | Exit 0; one live check passed in 35.23 seconds |

Free physical memory was 14,180,416 KB before the final full suite, 14,067,140 KB before Playwright and 13,573,368 KB before the live check. Each exceeded 3 GB. The suite emitted SQLite experimental, jsdom canvas and fixture line-ending warnings; build emitted dependency directive warnings. No final full-suite retry or flaky-test retry was needed.

An earlier full run exposed an extra gate-off shutdown await; it was removed and the shutdown cases passed. Another earlier full run passed before later review fixes. Two later partial runs were deliberately stopped on their verified owned process trees when material gaps were found. They are not counted as passes. The final run above covers all subsequent fixes.

## Regression and privacy evidence

Focused checks passed 108 tests, with six provider contract cases skipped, over `watcherTools`, `watcherNativeFences`, `watcherRecovery`, `followups` and `grokAdapter`. The final full run includes them. Coverage includes one current master, exact tool attachment and token revocation, permission/pending-request refusals, capacity and prompt caps, repeated keys, lost acknowledgement without replay, native question/takeover races, reserved creation without a target, lost native creation acknowledgement, targeted Stop fencing preparation, native Stop without answering, uncertain Stop reconciliation and user queue preservation. Child-process recovery preserves Sotto/native identities and does not add another turn.

History-off inspection recursively checks Sotto-owned files for distinctive synthetic message, draft and queue strings. Additional cases inspect corrupt and abandoned queue copies, retain ordinary backup items, and preserve dormant stable copies until Owl owns cleanup. A private unreadable queue recovers without another plaintext corrupt backup. Control references survive without storing their words.

The built Windows app checks both release tracks, private bridge availability, all five local-host-off refusals, unchanged limit, ordinary Send/reply, saved-kind preservation and stable layout recovery. Dark/light, reduced motion and bounds were checked at 1600x1000, 1280x800 and 820x560. Visually inspected the minimum-size [Owl dark](../../artifacts/watcher-thread-tools/owl-dark-820x560.png) and [stable light](../../artifacts/watcher-thread-tools/stable-light-820x560.png) captures; the existing controls and transcript fit. These two selected synthetic app captures are committed. Other generated captures stay gitignored; no live conversation was captured. No new renderer surface or design baseline was created.

## Live Codex

A fresh owned temporary project used the real native Codex account and production coordinator stack. Client version reported `0.162.1`. Three model turns were submitted under a hard six-turn ceiling. Watcher called `list_projects`, `start_thread` once and `read_thread`; it read the worker again while declining the requested answer. Its worker raised one native question. Watcher saw zero confirmation cards. The model declined to answer; a separate main-boundary queue/send probe returned `PENDING_USER_REQUEST`. Zero answer commands or replies to the held native request were observed, including cleanup. Selection remained unchanged.

The harness did not inspect or modify the user's provider configuration or credentials. Native sign-ins were used by the native client. Keep local history was off; the harness retained only counters, stable tool names/statuses and booleans, never prompt text, model output, tokens or protocol frames. The owned disposable fixture remains available for inspection. [Live metadata](../../artifacts/watcher-thread-tools-live/codex.json) and [gate metadata](../../artifacts/watcher-thread-tools-gates/gates.json) are gitignored. No more live turns were run.

## Reviews and decisions

Independent Standards and Spec reviews ran separately through Codex CLI on `gpt-6.1-sol` at max reasoning, read-only. Their closing reports pinned `e8c0dde6e`. Standards reported three hard findings; Spec reported two. All five were fixed with the regression cases above: queue-copy privacy, pre-writer/coordinator refunds, native creation/Stop uncertainty and the Grok cancellation fence. The heuristic duplicated settlement check was extracted. Earlier review findings also received fixes and regression coverage. The reviewers did not rerun tests or review the later commits; this note claims the observed validations above, not an independently clean final review. Two earlier heuristic concerns about typed tool dispatch and private-folder identity rules were retained; changing them would add abstraction without changing authority.

CONTEXT.md, ADR-0073 and the plan record the settled room contract, preview expiry, exact creation choices, cursor restart, guard/card identities, private native writer checks, request continuity, takeover recovery, refunds and uncertainty. The plan and ADR also reflect Zach's October 11 phone visibility decision. No phone code was built. Native launch profiles remain unchanged; adapters gained a private final-writer callback because native preparation can await after the workspace check.

Ticket 3 is complete. Event wakes/evidence, remote owning-host automation and renderer/phone surfaces belong to later tickets. Packaging, macOS, Linux, phones and publication were not exercised.


## Pull request #930 review follow-up

Verified all nine supplied findings against the implementation. Eight behavioral/evidence findings reproduced in failing regressions; the duplicated outcome handling was a valid refactoring finding and shares the refund fix. No finding was dismissed.

| Finding | Fix and regression | Local commit |
| --- | --- | --- |
| 1 | Refund definite queued preparation/native failures and thrown command failures once. Keep cancellation charged and unresolved native delivery reserved. Also reconcile a recovered uncertain receipt with a durable failed queue item. | `0df0ddaa5`, `e500ee5f6` |
| 2 | Return the latest 100 participations per roster row while preserving the complete durable record. A worker with 101 participations now returns a valid roster, including its latest takeover. | `8fc4a341f` |
| 3 | Return a matching settle receipt after the request closes. Conflicting keys and new work remain refused; the durable record and provider commands do not change. | `3311c2800` |
| 4 | Keep working-copy/base-ref IDs in their list snapshot. Expire or evict the choices with that snapshot; pagination performs no new native read. Three regressions cover pagination, expiry and eviction before admission. | `dc9131341` |
| 5 | Commit both linked minimum-size captures and verify the linked files exist and are not ignored. | `f5c18f188` |
| 6 | Use one outcome handler for returned errors, thrown errors and definite queued failures; the failure regressions cover its behavior. | `0df0ddaa5` |
| 7 | Preserve main's request/host/project context when converting image handles for the provider. Direct and queued image sends retain image bytes, request continuity and selection. | `45af8cd5b` |
| 8 | Drop older messages from an oversized initial window; keep ordered prefixes for forward reads. Fifty 2,000-character messages now retain position 49 rather than ending at 29. | `bb2e38376` |
| 9 | Accept the advertised restart sentinel. Thread, project and working-copy pages restart after expiry without changing selection. | `a7995c513` |

The focused tool, native-fence, recovery and capture-evidence run passed 51 tests. The neighboring ordinary staged-image suite also passed. The shared outcome refactor initially retained stale uncertainty after a definitive queued failure; its additional failing regression led to `e500ee5f6` before final gates.

Final ordered checks passed on Windows against code head `e500ee5f6b7519ebdf712565b69887f1085964ee`:

| Command | Real result |
| --- | --- |
| `npm run typecheck` | Exit 0 |
| `npm run lint` | Exit 0 |
| `npm test -- --maxWorkers=2` | Exit 0; 771 files passed, 58 skipped; 9,528 tests passed, 280 skipped; 1,043.90 seconds |
| `npm run notices:verify` | Exit 0; 189 components verified |
| `npm run build` | Exit 0; main, host, preload and renderer built |
| `npx playwright test tests/e2e/watcher-gate.spec.ts` | Exit 0; 3 passed in 10.1 seconds |

Free physical memory before the full suite was 13,428,320 KB, above the 3 GB threshold. The full run passed on its first attempt; no isolated flaky-case rerun was needed. Gate counters and statuses are retained in gitignored `artifacts/watcher-thread-tools-gates/pr930.json`, without prompt text, model output or protocol bodies.

The final built-app check drove stable and Owl ordinary Send/reply, saved-kind preservation and all local-host-off room refusals. It checked dark/light, reduced motion and layout bounds at 1600x1000, 1280x800 and 820x560. The two linked selected captures were refreshed from this final build and visually inspected. Packaging, other desktop platforms and phones were not exercised; the live Codex evidence above remains from the original implementation, with no additional paid model turns.

No renderer file or production dependency changed. The private room/preload contract, channel names and result shapes stay unchanged. These fixes follow the existing plan and ADR; they settle no new domain decision, so CONTEXT.md, ADR-0073 and the plan need no follow-up amendment. No nested review, provider-config access, paid live turn, push, merge, rebase, stash, branch switch, new worktree, publication or extra install occurred in this follow-up.
