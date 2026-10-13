# Phase 4 implementation

Baseline: `d596d832ea2466bb515d58560f11dc410ff3df78` on `main`; native baseline `52f1f42` is an ancestor. GitHub phase labels and current ticket bodies were read on 2026-09-13. Local delivery and commit are authorized; remote publication is outside this task.

## Deliverables and current state

- [x] #60 staging, commits and branches in the selected working copy; temporary-repository verification.
- [x] #62 checkpoint associations, coordinated native/file rollback, active-work guards, unrelated-edit preservation and interrupted recovery.
- [x] #66 live native usage and context, elapsed time, versioned API-equivalent estimates; replay/reset/model/cache correctness.
- [x] #69/#70 durable Claude/Grok personal chats; original provider binding, native skills/history/requests, restart and memory boundaries.
- [x] #72 editable/copyable prompt generation; corrected decisions, missing details, fixture evaluation and human review status. Format remains provisional pending human review.
- [x] Integrated typecheck, lint/build, focused tests and full suite at the end; rerun after discovered test-harness failures were corrected.
- [x] Separate Standards and Spec reviews against the baseline, findings resolved; delivered in the Phase 4 implementation commit on main.

Parallel owners: git_checkpoints (#60/#62), usage (#66), native_chats (#69/#70), root (#72 and integration). Preserve the two pre-existing untracked user PNGs. Per-slice evidence is recorded in adjacent phase-4 documents.

## Interface acceptance

Target is the existing Windows Electron desktop from the approved plan: normal 1280/1600 windows and 820x560 minimum, pointer and keyboard, light/dark and reduced motion. Retain Sotto branding and existing theme tokens. Reference is the existing rendered phase-three interface plus pinned T3 source at `.claude/tmp/t3-reference-24` (`d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`).

Prompt editing is a focused writing surface whose proving action is editing and copying a useful prompt while the original chat remains intact. Considered: inline transcript insertion, a persistent side panel, and a focused editor dialog. Chosen: an editor dialog opened from the current chat's actions, leaving transcript/composer space intact.

- [x] Dialog keeps editable text dominant; title, review instruction, editor label, Copy, Close and deliberate Regenerate (six purposes; status feedback only as needed).
- [x] Existing palette/type family; meaningful controls at least 14px, body 16px, secondary text at least 12px; no decorative artwork or new branding for this scoped tool.
- [x] Focus enters editor, stays inside dialog, returns to opener; Escape closes; copy succeeds or shows actionable failure; no output sends automatically.
- [x] Brief opening transition follows existing motion timing with reduced-motion parity; no continuous animation is needed for a writing tool.
- [x] Inspect normal/minimum screenshots and actual Electron journeys; record exact views, copy counts and remaining limitations.

## Test boundaries

The recovered TDD skill at `D:/Fleet/snapshots/laptop/agents/skills/tdd/SKILL.md` requires pre-agreed seams. These already appear in the approved plan's Cross-cutting acceptance and the six tickets: Git/checkpoint commands with temporary repositories, native-provider events and saved-chat APIs, usage and prompt-generation input/output, and Electron user journeys. The initial extra confirmation question was unnecessary; implementation uses that existing agreement, not silence as consent. Focused red/green regressions cover newly discovered failure modes at those public boundaries.

## Integrated verification

Final node/web typecheck, ESLint and production build passed. Five Electron journeys passed on the final built source: completed checkpoint review and coordinated rewind; Claude/Grok personal chats and native requests/reconnect; editable prompt/copy/latest-correction regeneration; unreadable-cache recovery; full personal-chat restart. Root inspected final minimum-size prompt, usage disclosure, native permission and checkpoint screenshots; lane owners inspected the broader 1280/1600/820 light/dark matrix.

Final full suite: **3,310 passed, 20 skipped, zero failures**, across 244 test files, using two workers. [Machine-readable summary](phase-4-suite.json). Skips include opt-in native runs that were exercised separately as documented below.

The default full-suite discovery initially entered the ignored T3 reference checkout; `.claude/tmp/**` is now excluded alongside existing worktree exclusions. The subsequent full run exposed stale IPC method inventories and three older Settings tests that omitted navigation to their existing Appearance/Application tabs. Assertions now follow the actual UI and all newly registered IPC channels. Its transport/time-sensitive failures passed unchanged with two workers, so the final complete run uses `--maxWorkers=2` rather than oversubscribing this Windows machine.

Native opt-in verification passed separately: Codex's installed App Server accepted exact native rewind and preserved its original identity after restart (two synthetic turns, 23.12 seconds); Claude's installed zero-inference fork/adapter rewind and interrupted-write recovery passed; both installed Claude/Grok personal clients retained their own native identity and selected skill across restart. Codex evidence: `artifacts/phase-four-checkpoints/codex-native.json`; Claude/Grok evidence is linked in the native-chat document. These are owned synthetic discussions, not user conversation probes. Full-suite defaults skip opt-in native tests.

The final Windows unpacked package at `release/phase4-verification/win-unpacked` passed resource, pinned SDK hashes, notices, production ASAR inventory, SQLite/FTS5, real packaged node-pty and normal UI/audio-worklet smoke checks. It uses final source input revision `833b71ca18ae3cd4752daf2cc71f2735d745ab8a512ffcc463d5384498392830` and build SHA256 `7f829b04a7dc73f34210b003b936eff6c0bad2406753002bb5cb4981fc8a1480`; provenance records the precommit baseline plus this exact dirty-source revision. This is an isolated verification package, not an installed or published release. No macOS build or installer verification was performed.

Separate [Standards and Spec reviews](phase-4-review.md) have zero outstanding findings after fixes. Detailed slice evidence: [Git/checkpoints](phase-4-git-checkpoints.md), [usage](phase-4-usage.md), [native chats](phase-4-native-chats.md), [prompts](phase-4-prompts.md). Remaining acceptance qualification: the prompt rubric and real generated examples are ready for human review; the prompt format is not declared proven before that review.
