# Phase 1 backend implementation and remaining UI

Integration branch: `work/threads-phase-1`, starting at `7e3809f` on `work/thread-providers` (includes required native baseline `52f1f42`). Parent checkout and its untracked artifacts are preserved. Scope: GitHub #44, #45, #46 and #73, as published in the workspace plan. No remote publication or issue closure is authorized by this implementation request.

## Deliverables and acceptance

- [ ] #44: Enter/Shift+Enter and IME guards; per-thread text/attachment drafts across navigation/restart; legacy ownership migration; truthful delivery states; uncertain acknowledgement reconciliation without duplicate submission; measured local feedback under the 100 ms target separately from provider latency.
- [ ] #45: project folders with multiple threads and provider icons; create/open project; individual and whole-project settlement/restoration preserving prior states; search and working/attention indicators; history/identity/scopes retained while disconnected; ready-provider selection before native conversation starts, original provider retained afterward.
- [ ] #46: safe streaming Markdown, highlighted/copyable code, tables/quotes/links, supported image/file metadata; stable earlier-history reading and jump-to-latest; responsive long histories; keyboard and desktop/minimum-size Windows verification.
- [ ] #73: persisted light/dark/system and accent choices with immediate application and migration; all main surfaces and native controls use theme tokens; explicit supersession of black-only product rule; widget/dictation preserved; focus/contrast/reduced-motion/scale capture gates retained and extended.
- [ ] Integrated typecheck, lint, focused and broad tests, production build, relevant Electron journeys and rendered inspection.
- [ ] Independent review, fix material findings, final acceptance audit and usable local delivery.

## Implemented locally

Three independent backend agents worked in isolated worktrees and committed their changes. The parent integrated all three into this branch, added cross-feature tests, and fixed findings from integration and an independent backend review. No renderer/CSS files were changed. No complete Phase 1 ticket is claimed finished.

| Ticket | Implemented backend | Still required |
| --- | --- | --- |
| #44 | Per-thread text/image drafts, legacy ownership migration, durable delivery states, exact acknowledgement reconciliation, no automatic replay | Renderer persistence wiring, keyboard/IME guards, visible status states and keydown-to-visible-frame measurement |
| #45 | Durable project/thread settlement, restoration, disconnected history, local unstarted provider choice, native provider locking | Project-folder UI, provider icons, settlement controls and provider-picker integration |
| #46 | Validated submitted-image previews, exact message identity, bounded persistence and privacy cleanup | Rich Markdown/code/tables/links, preview rendering, scroll behavior and long-history checks |
| #73 | No implementation | Appearance settings, theme/accent tokens, migration, capture-matrix extension and rendered review |

Integrated commits: `36ac8bb` (drafts/delivery), `d52db44` (workspace organization), `a247d00` (attachment previews), and `1e8ec8c` (integration checks and provider timing). Final privacy fixes and this verification record follow them on the same branch.

The [backend contracts](phase-1-backend-contracts.md) preserve the exact renderer integration requirements, state fields, commands, identity rules and limitations. Original agent reports and command logs remain in `.worktrees/phase1-orchestration` in the parent checkout.

## Verification on Windows, September 12, 2026

- Final full Vitest run: **2,370 passed, 9 existing tests skipped**, 144 passing files and four skipped files. Command: `npx vitest run --maxWorkers=4 --reporter=dot`. No paid native-provider calls were made.
- Final TypeScript, full ESLint, production build and `git diff --check` passed.
- Before the final privacy fixes, **30 Electron journeys passed** across thread workspace/creation, agent control/answers/attention, provider settings/recovery and agent settings. This includes real main/preload/renderer composition with controlled external providers, not a claim of paid native-provider compatibility.
- Final post-fix Electron regression: **21 journeys verified** across app, provider recovery and thread workspace. The batch passed 20 and found one pre-existing stale transcription-error copy assertion. Source comparison confirmed the app's existing “Transcription failed” copy was unchanged; correcting that assertion and rerunning the affected journey passed. Clipboard/paste/history assertions were preserved. These checks exercise onboarding, dictation, history off, persistence/reload, native window/widget behavior, provider recovery and thread drafts.
- Six parent integration tests combine WorkspaceHost, ConfiguredProviderHost, SottoThreadHost, real persistence and the controller. They cover drafts plus individual/project settlement across disconnect/restart; an unstarted provider change retaining draft/project scope; exactly one accepted send and restored image previews; separate provider timing; corrupt-cache cleanup; and independent privacy cleanup/retry under preview-only and workspace-only storage failures.
- Native protocol fixtures use the real Codex/Claude adapters with synthetic child processes. They verify delayed acknowledgement/restart and exact provider/session identity without duplicate prompt dispatch.
- Baseline before changes: 2,309 tests passed with four workers. A default-concurrency run had two timeouts; the affected 39 tests and the complete four-worker baseline passed. No timeout assertion was weakened in this integration.

## Review findings and fixes

The independent reviewer reproduced two P2 defects in the initial merge. A failed preview-store cleanup prevented writable workspace/coordinator stores from redacting history, and corrupt workspace recovery created an unmanaged transcript backup. Parent regressions reproduced both before fixes.

Privacy changes now attempt every independent store, report a failure, and retain a retry obligation for the existing maintenance timer. Tests inject preview-only and workspace-only failures, verify the other stores redact immediately, then restore writes and invoke the actual maintenance callback to verify recovery. Workspace cache recovery uses non-backing-up reads and removes only its generated temporary/corrupt-copy basenames; an unrelated similarly named file remains intact. The final focused privacy/recovery batch passed **105 tests**.

The parent also reproduced a timing integration defect: 500 ms of simulated image-cache persistence plus 7 ms of provider execution reported 507 ms of provider latency. The timer now covers provider execution only; the regression reports 7 ms. The preceding timing/turn/draft batch passed 56 tests. These are backend timing checks; the required visible-feedback measurement remains outstanding.

## Concrete blocker and continuation

The Claude Fable UI worker returned HTTP 429 before implementation: **Fable usage limit reached**. [CLAUDE.md](../../CLAUDE.md) specifies **“Claude Fable 5.1 only”** for design/UI and **“Never send design work to Codex or Grok.”** The user was asked whether to permit Codex for this task's UI; no answer was received during backend implementation. No model substitution was made.

Resume the remaining UI from this branch when Fable is available or the user explicitly grants the exception. Read the approved workspace plan/product discussion and the backend contracts before editing. Tastify was loaded for this task; its target is already specified as Windows desktop Electron at normal and minimum sizes. Reference, composition, typography, color, copy, motion, keyboard/scale and rendered acceptance checks remain pending with the UI work. Preserve Sotto branding and the widget's separate behavior; #73 explicitly supersedes the prior black-only requirement.

The pinned T3 reference checkout at `.claude/tmp/t3-reference-24` in the parent workspace was verified as `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`, and the implementing agents inspected the matching native and user-flow source.

## Remaining verification boundaries

Windows desktop automated journeys were exercised. New UI rendered acceptance, macOS, physical microphone, production packaging/release and paid live-provider calls were not exercised by this phase. The required native foundation is included locally; this task does not imply completion of release gate #24. No release, push, merge into main, issue closure or replacement of the user's running development app was performed.
