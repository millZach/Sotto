# Phase 5 implementation

Baseline: `896c4e4bce223b616809adefdcd12fe9bfe42b7e` on `main`. Native foundation `52f1f42` is an ancestor. Current GitHub bodies for #61, #67 and #71 were read on 2026-09-13. Local implementation, controlled tests, review and commit are authorized; publishing a real branch or PR is not inferred from implementing its UI.

## Deliverables and current state

- [x] #61: explicit push and duplicate-safe pull requests, correct working copy and remote/base, editable title/body, actual reviews/checks and errors, preferred browser links.
- [x] #67: supported native compaction, truthful lifecycle and duplicate prevention, exact pinned Claude predicate/dismissal/resume choices, native defaults retained.
- [x] #71: captured personal-chat dictation and conversational voice ownership, saved native history, Grok/Kokoro playback and interruption/mute, no implicit project authority. Physical microphone check explicitly deferred.
- [x] Focused public-boundary tests and regular typechecks.
- [x] Actual Windows Electron journeys and normal/minimum light/dark visual inspection.
- [x] Full test suite at the end, production build and lint.
- [x] Independent Standards and Spec reviews; fix material findings.
- [x] Commit final work on current `main`, preserving unrelated user files.

Owners: `git_pr`, `compaction`, `personal_voice`; root integrates and verifies. The pre-existing untracked `artifacts/composer-dev-live.png` and `artifacts/formatting-quality-native-menu.png` are unrelated and must not be committed.

## Acceptance and test boundaries

The approved plan establishes the Windows desktop target (1280/1600 and minimum 820x560), themes, keyboard and reduced-motion coverage. Apply Tastify within existing Sotto branding and controls, with existing rendered captures and pinned T3 at `.claude/tmp/t3-reference-24` as references. Each slice records its concept, observable hierarchy/type/copy/motion checks and inspected states in its evidence document. No new desktop-versus-phone decision is required.

The recovered TDD skill is `D:/Fleet/snapshots/laptop/agents/skills/tdd/SKILL.md`. Use the already agreed seams in the approved plan: Git services with controlled repositories/API boundaries, native provider protocol and public conversation APIs, clock-controlled context state, and Electron user journeys. Use focused red/green regressions for behavior; do not test implementation structure. The review fixed point is this task's baseline above.

## Outstanding acceptance evidence

- Real remote publication needs explicit authorization; use faithful GitHub API fixtures and an owned local remote to exercise the publication path without publishing user work.
- Physical microphone-to-response verification is explicitly deferred by Zach: "Finish automated checks, leave physical test pending." Synthetic audio or injected transcripts must be labelled as such; report measured segments without claiming unmeasured latency.
- macOS verification and the existing voice-budget/release gates retain their separate scope.

## Integration observations

All five prerequisite tickets (#60, #66, #68, #69 and #70) are closed on GitHub. Baseline node/web typechecking and 132 IPC/preload tests passed. Root inspected the existing minimum-size Git actions and personal-chat request captures before integration.

The Windows Computer Use `@oai/sky` helper failed to connect its native pipe, including retry and a reset/reinitialization. Use the existing Electron Playwright harness for development UI journeys and screenshots; do not claim separate OS-level interaction from those checks.

## Integrated verification

Final production build, node/web typechecking and ESLint passed. Root repeated the saved-chat voice Electron journey after final state guards (all three provider fixtures), the Git smoke after final destination/disabled-state fixes, and the compaction state journey after final recovery and dismissal fixes. The owned Git smoke pushed commit `cc82c72aadbf2307eb3519436c75babd19da40d8` only to its disposable local bare remote, with zero real GitHub writes. PR API create/reconciliation uses faithful CLI fixtures; the installed gh accepted the selected read-only JSON fields.

Installed Codex and Claude clients separately completed native compaction, returned idle and retained only the original synthetic user prompt as authored history. Large aged-context recommendations and native resume dialog choices use clock-controlled/native-protocol fixtures, not a manufactured claim of an aged live 100,000-token conversation.

Root inspected the affected Git, voice and compaction views, including all six built-in palettes (Sotto, Rose, Fern, Tide, Copper, Dusk) in light/dark at 820x560. Their complete normal/minimum capture matrix is retained beside each slice; root additionally inspected normal-size views and the minimum error/completion states. Review contact sheets are under `artifacts/phase-five-review/`. Forms remain scrollable with reachable actions, focus rings remain distinct, voice controls fit beside the composer, and compaction feedback wraps below usage without clipping. Existing Sotto typography, identity and theme roles remain. Imported user themes are not a finite test matrix.

The initial full suite exposed two test-harness failures: an old full-module AgentContext mock lacked the newly used optional hook, and a native dialog test read the child's trace immediately after the pipe write, before child consumption. The mock now preserves real unmocked exports, and protocol assertions await the exact request's response. Both focused regressions pass; no production behavior was changed to accommodate those failures.

The corrected final full suite passed with **3,336 tests passed, 22 skipped, zero failures**, across 249 test files (`npx vitest run --maxWorkers=2`). The opt-in native compaction checks were also run separately against installed clients, as described above. Machine-readable counts are retained in [phase-5-suite.json](phase-5-suite.json). Implementation, regression tests, review and visual evidence are included in the local Phase 5 commit on `main`; nothing was pushed.

Independent [Standards and Spec reviews](phase-5-review.md) have zero outstanding findings. Detailed evidence: [Git/PR](phase-5-git-pr.md), [compaction](phase-5-compaction.md), [personal voice](phase-5-personal-voice.md). This is local implementation and a production development build, not a published branch, installed release or macOS verification. Existing voice latency and native release gates retain their scope.
