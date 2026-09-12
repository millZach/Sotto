# Ticket 16: working preferences and memory inspector

Implements [issue 16](https://github.com/millZach/Sotto/issues/16) and the questionnaire/inspector portion of the [memory-first spec](../superpowers/specs/2026-09-10-sotto-memory-first-prototype-spec.md).

## Behavior

- First entry to Agents asks seven conversational questions, followed by confirmation boundaries and a review. Dictation is independent. Not now keeps the draft for this session; Memory resumes it. Nothing is persisted until Save preferences.
- One transaction saves explicit global preferences, dated questionnaire provenance, any selected always-confirm policies and completion state. Unchecked boundaries grant nothing. Privacy and autonomy prose are preferences; they do not import histories or grant permissions.
- The Memory page lists current memories, source and dates, expandable complete metadata/provenance, past versions and separate read-only policies. Edit and Supersede create a new current version. Delete explicitly confirms permanent deletion of all versions; deleted text cannot reappear from the full-text index.
- The coordinator retrieves current explicit global/matching-project preferences for interpretation and supervision, bounded to 20 memories and 14,000 content characters (enough for all seven maximum-length questionnaire answers). Whole preferences are selected without truncating qualifiers. Other projects, superseded/disputed/inferred entries and permission evidence are excluded. Preferences are data; current instructions and existing authority checks remain controlling.
- Memory is local in the existing SQLite store. The UI discloses that selected preferences go to the configured reasoning provider with requests. The widget cannot inspect or mutate memory.

## Verification

- Store tests cover atomic rollback, durable completion, provenance, immutable supersession history, stale IDs, complete-chain deletion/FTS, scoping, validity and separation from policy grants.
- IPC/preload tests cover trusted-main-only access, malformed payloads/responses/events and unavailable storage.
- `agentMemoryIntegration.test.ts` uses the real SQLite store, profile, coordinator, configured reasoner and turn recorder. An external subscription stub receives the actual structured preferences and supplies contrasting replies; after editing and reopening the controller/store, the visible notice changes and policy records remain identical. This proves persistence and prompt plumbing, not live-model preference adherence. Permission requests remain pending until explicit user approval.
- Renderer tests exercise first use, dismissal/resumption, one atomic reviewed save, failure states, editing/history and confirmation before deletion.
- `tests/e2e/memory.spec.ts` runs the actual Electron/preload/main/store journey: save, edit, restart, retained history, supersede, full deletion and unchanged policies. Desktop, 420px-wide inspector and 720px-wide stale-edit captures were inspected for wrapping, controls and overflow.
- Captures: `artifacts/memory/questionnaire.png`, `boundaries.png`, `inspector.png`, `inspector-narrow.png`, `history.png`.

## Standards

The independent review found two P3 findings: ADR-0003 still described skipped E2E storage and thread-only provenance; the policy record schema was duplicated between storage and IPC. The ADR now explicitly records the ticket #16 amendment, and storage uses the same shared policy schema as IPC. No other grounded standards or correctness findings were identified.

## Spec

The independent review found no actionable ticket #16 gaps or material scope creep. It identified a future retrieval consideration: long answers could exceed the original context cap. The cap is now derived from the seven allowed answer lengths, with a restart regression proving all seven maximum-length answers fit. Request-relevant lexical retrieval remains ticket #17.

Review totals: Standards 2 findings resolved (both P3); Spec 0 actionable findings.

## Final checks

Verified the committed code in an isolated worktree, excluding the unrelated local composer and dropdown changes:

- Full Vitest run: 2,199 passed, 8 skipped, one outdated IPC surface assertion failed. Updated it for the new memory bridge and checked that the bridge is frozen. The focused IPC/preload rerun passed all 127 tests, resolving the sole failure; 2,200 active tests verified across the full run and focused rerun.
- Typecheck, full ESLint and production build passed.
- Five Electron tests passed: two memory journeys, the Crossing navigation/dictation journey, and two thread-workspace journeys. Inspected captures from the committed build at desktop, 420px and 720px widths.
- Standards review verified both fixes and the final IPC amendment; no remaining findings. Spec review verified the final context limit and conflict test; no actionable findings.

The work is committed locally on `main`. This task does not publish a release or close the remote ticket. Live-model preference adherence and macOS execution were not exercised.
