# Owl code health, November 9, 2026

This pass scans `src`, the desktop and headless application, together. The native mobile apps and product-events worker are separate programs and are not included in this assessment.

## Completed changes

Eight work groups address fourteen review findings and four overlapping mechanical findings:

- Recheck a remote client's permission to answer immediately before dispatch, after asynchronous persistence. A revoked grant leaves the request waiting and removes the unsent outbox entry.
- Keep the newest supplier when JSON writes coalesce, while preserving explicit-write ordering.
- Honor the socket host's event limit after filtering and ordering, before cloning.
- Serialize each host's phone reads and commands, and refresh a new connection generation after an older read finishes. Keep phone controls busy from command admission until all queued commands finish, including failures.
- Move shared renderer helpers out of views into their owning modules, remove the resulting import cycles, and retain typed thread-start data without serializing it through JSON.
- Require every adapter to supply its marked thread and rest readers. Remove the unused snapshot-only compatibility mode; retain whole snapshots for initial publication and recovery.
- Name throwing guards and identity mutations explicitly, repair two misleading comments, and remove the unused working-copy component and its styles.
- Build the Darwin key-listener helper in suite setup so individual tests do not depend on another test running first.

The renderer changes preserve existing controls and wording. Generated translation catalogs move source references and remove strings belonging only to the deleted component.

## Verification

- `npm run typecheck`: passed all four configurations.
- `npm run lint`: found two unused imports; both were removed and the two affected files passed a focused ESLint rerun. All other files passed the full run.
- Seven focused unit files passed, 192 tests in total: authority (100), host phones (14), atomic JSON storage (31), adapter changes (11), socket host features (29), code-size budgets (3), and interface catalogs (4).
- Unit runs used `NODE_OPTIONS=--no-experimental-webstorage` because Node 25.8.2 otherwise exposes a `localStorage` object without the `clear` method expected by the existing test setup.
- `npm run i18n:extract`: completed; generated catalogs are included.
- Full suites, integration tests, packaging, app launches and design captures belong to GitHub CI for this work. No local app was launched.

Independent GPT-6-Astra diff review found a phone-dialog busy-state regression while commands waited behind reads. That finding produced the command-admission fix and its regression test; the followup review was clear. Final typecheck and focused lint checks passed after those changes. The final scanner result is recorded in the pull request.

## Assessment and remaining work

The initial unassessed strict score was 23.5. Completing twenty blind dimension reviews produced a fully assessed baseline of 87.8 before these fixes; that jump is assessment completion, not code improvement. The reviewer was GPT-6-Astra, explicitly selected by the user instead of the skill's default.

Seventeen review findings remain deferred in twelve groups. They are not fixes and are not permanent dismissals:

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
| Integration completion signals | Replace one fixture family's sleeps with observable completion; run in GitHub. |

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
