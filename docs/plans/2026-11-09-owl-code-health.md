# Owl code health, November 9, 2026

This pass scans `src`, the desktop and headless application, together. The native mobile apps and product-events worker are separate programs and are not included in this assessment.

The initial eighteen fixes landed in [pull request 2360](https://github.com/millZach/Sotto/pull/2360), at merge commit `552adb03ca1464702e75792723bedd1aea89256f`. The seven follow-up findings below are a separate change based on that merged main.

## Completed changes

Fourteen work groups address twenty-one review findings and four overlapping mechanical findings:

- Recheck a remote client's permission to answer immediately before dispatch, after asynchronous persistence. A revoked grant leaves the request waiting and removes the unsent outbox entry.
- Keep the newest supplier when JSON writes coalesce, while preserving explicit-write ordering.
- Honor the socket host's event limit after filtering and ordering, before cloning.
- Serialize each host's phone reads and commands, and refresh a new connection generation after an older read finishes. Keep phone controls busy from command admission until all queued commands finish, including failures.
- Move shared renderer helpers out of views into their owning modules, remove the resulting import cycles, and retain typed thread-start data without serializing it through JSON.
- Require every adapter to supply its marked thread and rest readers. Remove the unused snapshot-only compatibility mode; retain whole snapshots for initial publication and recovery.
- Name throwing guards and identity mutations explicitly, repair two misleading comments, and remove the unused working-copy component and its styles.
- Build the Darwin key-listener helper in suite setup so individual tests do not depend on another test running first.
- Reject non-object SSH helper and DevTools messages at their JSON boundaries. Enforce the existing DevTools per-message byte limit before buffering a complete frame, including one split across reads.
- Preserve Git remote-discovery errors unless Git returned numeric exit code 1 for no matching configuration keys. Handle those failures in the status reader so its cached pull request survives and retries use the normal delay.
- Keep symlink target checks within the folder browser's existing limit of sixteen concurrent filesystem calls.
- Trust settings already normalized by the store and apply runtime projection once when presenting them. Keep saved-value normalization.
- Return the existing unavailable message when a Cloud iPhone action throws or rejects, without publishing a failed session or exposing raw errors.
- Name the private newest-turn status helper for the lifecycle flags it returns.

The renderer changes preserve existing controls and wording. Generated translation catalogs move source references and remove strings belonging only to the deleted component.

## Verification

- `npm run typecheck`: passed all four configurations.
- `npm run lint`: the initial full run found two unused imports; both were removed and passed a focused rerun. Every source and test file in the follow-up batch passed focused ESLint checks.
- Fourteen focused unit files passed, 318 tests in total, with one Windows-only skip on this Mac. The initial batch covered authority (100), host phones (14), atomic JSON storage (31), adapter changes (11), socket host features (29), code-size budgets (3), and interface catalogs (4). The follow-up covered DevTools (14), SSH helpers (2), GitHub remotes (23), Git status (25), host folders (17 and one skip), settings (27), and Cloud iPhone actions (18).
- The new parameterized Cloud iPhone test initially failed typecheck because its failure mock inferred incompatible result types. An explicit `Promise<never>` return type fixed that test; final typecheck and its focused rerun passed. Interface catalogs also passed again after extraction.
- Unit runs used `NODE_OPTIONS=--no-experimental-webstorage` because Node 25.8.2 otherwise exposes a `localStorage` object without the `clear` method expected by the existing test setup.
- `npm run i18n:extract`: completed; generated catalogs from the initial batch are included. The follow-up extraction required no further catalog changes.
- Full suites, integration tests, packaging, app launches and design captures belong to GitHub CI for this work. No local app was launched.

Independent GPT-6-Astra diff review found a phone-dialog busy-state regression while commands waited behind reads. That finding produced the command-admission fix and its regression test; the follow-up review was clear. The protocol follow-up also passed review. Review of the other follow-ups found that propagated Git discovery errors escaped the status reader's failure boundary; the caller fix preserves cached results and retry delays, with timeout and abort regressions. The caller fix's final independent review was clear. These reviews inspected source and tests; they did not exercise live SSH or Chromium.

## Assessment and remaining work

The initial unassessed strict score was 23.5. Completing twenty blind dimension reviews produced a fully assessed baseline of 87.8 before these fixes; that jump is assessment completion, not code improvement. The reviewer was GPT-6-Astra, explicitly selected by the user instead of the skill's default.

A fresh blind review reassessed the eighteen affected dimensions and produced a strict score of 88.7; the other two dimensions retained their earlier assessments. It identified the seven focused follow-up fixes above. Resolving those findings does not itself re-rate the subjective dimensions.

The subsequent mechanical rescan reported strict 88.6. It retained subjective assessments and marked affected dimensions stale; this is not a new blind assessment of the completed fixes. Reopened heuristic findings and the wider mechanical backlog remain visible rather than being counted as completed work.

After the fresh review, twenty-five recorded findings remain deferred. Three older findings overlap their replacements, leaving twenty-two distinct concerns in sixteen groups. All twenty-two followup steps remain unfinished; these are not fixes or permanent dismissals:

| Followup | Why it needs a separate change |
| --- | --- |
| Watcher record/archive ownership | Follow the ADR-0190 extraction checkpoint and preserve durable publication order. |
| Host runtime capability contract | Separate provider and workspace responsibilities, including inactive startup and shutdown. |
| Partial broadcast types | Preserve reconstruction and streaming copy budgets while expressing omitted fields. |
| Provider and settings package layout | Audit source, test, fixture and script paths as one move. |
| Microphone sampling ownership | Verify navigation, visibility and device-change lifetimes before moving it. |
| Socket feature predicates | Preserve the Owl, host, admin and default-inclusion capability matrix. |
| Appearance initialization | Verify both main and popup bootstrap and teardown. |
| Durable Teams and delegation failures | Define truthful partial-success behavior and fail-closed startup cleanup. |
| SQLite rollback errors | Requires the user's scope decision for an uncommon double-failure case. |
| Preload promise refusals | Separate asynchronous calls from synchronous subscription setup. |
| Send outcomes and followup lifecycle | Settle absent-receipt semantics before sharing lifecycle code. |
| Integration completion signals | Replace the Watcher and product-event fixtures' sleeps with observable completion; run in GitHub. |
| Workspace state ownership | Separate serialization caches and worktree recovery without changing durable commit points. |
| Workspace constructor options | Replace optional positional policies after the ownership and provider choices settle. |
| Held-provider migration | Inventory old boolean callers before removing internal compatibility forms. |
| Relayed caller types | Express the caller's actual fields while preserving identity and authority checks. |

The mechanical backlog also remains. Size, coverage and other heuristic findings need code-specific decisions; this pass does not declare the whole repository clean.

## Scanner issues

False positives were dismissed only after inspecting their code: guarded JSON parsing, literal CSS/DOM tokens mistaken for secrets, fixed SVG markup, unrelated uses of the word “deprecated,” and runtime/build entrypoints mistaken for orphan modules.

The following reports preserve tool defects separately from application defects:

- [Guarded JSON parsing](https://github.com/peteromallet/desloppify/issues/786#issuecomment-6617955025).
- [Literal CSS/DOM tokens reported as secrets](https://github.com/peteromallet/desloppify/issues/964).
- [Weighted coverage denominator displayed as files](https://github.com/peteromallet/desloppify/issues/965).
- [Temporary clustered deferrals treated as permanent during triage](https://github.com/peteromallet/desloppify/issues/966).
- [Unrelated deprecation text attached to a later declaration](https://github.com/peteromallet/desloppify/issues/967).

Raw scanner state and blind review packets remain local in `.desloppify/`; they are not application source or release artifacts.
