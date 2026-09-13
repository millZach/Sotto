# Phase 3 implementation checklist

Scope: all ten Phase 3 GitHub tickets plus Zach's requested replacement of the standalone accent picker with T3 Code desktop themes. Repository millZach/Sotto; implementation baseline `bf500b42f91cfc1bd198c2d75d62ee48ef4232a8`. All prerequisite tickets were verified closed. #24 remains a separate release gate. Authorized delivery is local commits on main; no push, issue updates, merge, publication or release.

## Deliverables and current state

| Ticket | Acceptance | State |
| --- | --- | --- |
| #49 | Claude native activity, subagents, order and reconnect | Implemented; native/fixture evidence, final review pending |
| #50 | Grok ACP activity, subagents and retained history | Implemented; native evidence and identity reconciliation regression pass |
| #52 | Complete native questions and exact once-only approvals | Implemented; thread and personal full-app journeys pass |
| #54 | Three/four/more pane layouts, row dividers, persistence and zoom | Implemented; focused tests and integrated Windows restart journeys pass |
| #56 | Retained real PTY terminals, hide/reopen/restart and Windows Ctrl+C | Implemented; actual and packaged PTY pass; live palette and reduced-motion updates implemented; actual theme-control journey passes in UI worktree; main confirmation pending |
| #57 | Retained isolated HTTP(S) browser and external-default link routing | Implemented; real native view verified; mount-failure recovery implemented and complete-app verified |
| #59 | Actual working-copy Git changes/diffs and honest unavailable states | Implemented; full-app journey passes; short tools-header correction implemented and rendered |
| #64 | Claude native skill catalog, scope and expansion | Implemented; installed-native expansion and picker journey pass |
| #65 | Grok native catalog and expansion or truthful limitation | Implemented; installed-native expansion and picker journey pass |
| #68 | Durable project-free Codex chats, global memory and stable provider identity | Implemented; storage recovery and full-app restart pass; failed-send recovery and whole-block/skill merge verified |
| Themes | T3 mode previews, six dual-palette themes, independent halves, create/edit/duplicate/delete/import/export, community themes, contrast/glass | Implemented and integrated; full theme library and icon/orb/widget journeys pass in isolated Windows build |

- [x] Focused regressions and periodic typechecks throughout implementation.
- [x] Independent backend audit; personal cache loss and Grok stream identity corrected and verified.
- [x] Windows native provider, PTY, browser, Git and full-app request/chat/layout checks.
- [x] Resolve browser refusal, failed-send text/skill recovery, live terminal palette/motion, and live Open VSX findings.
- [x] Verify the short Tools header correction and terminal through actual theme controls in the integrated UI worker; main confirmation and independent critic pending.
- [ ] Integrate and inspect final themes, icon/orb/widget, and inspector/minimized-editor corrections across normal and short Windows views.
- [x] Resolve independent visual critic findings: browser visibility for a nonintersecting minimized editor, Send overlap, and long failed-message diagnostics. All ten combined theme/branding/recovery journeys pass at 7b0aec4. Expansion after a low drag is an additional correction still being verified.
- [ ] Independent parallel Standards and Spec reviews against the fixed baseline; resolve material findings.
- [ ] Final repository suite, lint, typecheck, build, runtime/notices and current Windows packaged verification.
- [ ] Final evidence and local commits; actual completion report.

## Design and reference acceptance

Target: existing Windows Electron application at 1600/1280 and minimum 820x560, pointer and keyboard, light/dark/system and reduced motion. Use semantic palette colors throughout. Preserve the established transcript-led workspace, typography and behavior while replacing the rejected accent system. Keep controls readable, content dominant and short-window actions reachable; no clipped composers, obscured request actions or empty native views presented as verified rendering. Inspect actual captures, not only geometry assertions.

T3 source is pinned at `.claude/tmp/t3-reference-24`, commit `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`. User supplied the appearance reference and selected Ocean in that image; root disclosed Ocean as the reversible initial/migrated palette for both halves. Preserve mode and saved future selections. Latest user correction: the app icon and voice sphere, including the widget icon and voice visualization, must follow the selected theme. The widget can retain its system-resolved mode while consuming the corresponding selected palette. The former frozen-widget palette is superseded. Desktop theme capability includes local T3/VS Code import/export and Open VSX; server publication CLI and mobile-specific controls do not apply to this local desktop architecture.

## Evidence index

- `phase-3-providers.md`: installed Claude/Grok activity/catalog/expansion and reconnect; live subagent execution was not exercised (source/fixtures cover projection).
- `phase-3-chat.md`: native Codex personal turn/resume and global-memory separation.
- `phase-3-chat-recovery.md`, `phase-3-backend-audit.md`: long-reply and corrupt-storage recovery; preserved original bytes and stable identities, no replay.
- `phase-3-tools.md`: real Windows PTY, Git and retained isolated WebContentsView.
- `phase-3-requests.md`, `phase-3-ui.md`, `phase-3-layout.md`: focused and complete-app UI journeys plus inspected captures. Earlier worker checkpoints are distinct from final combined acceptance. The three browser/chat/terminal recovery journeys also pass on the integrated theme build; real theme-control and latest widget checks remain pending.
- `phase-3-packaged-windows.md/.json`: full package verifier passed at source `7a16629`; later UI/theme/Grok/storage changes require a new final package checkpoint. Production modules, actual PTY and SQLite were verified. Mac remains unverified here.
- Root `phase-three-personal-bridge.spec.ts`: two saved conversations/restart/default-provider change, and corrupt-cache startup leaves other app functions usable without altering original bytes.
- Root `phase-three-personal-requests.spec.ts`: complete personal form, refused-answer retry, omitted optional field, exact native permission and durable decision IDs; no extra user message or project.
- Root `phase-three-tools-bridge.spec.ts`: PTY output/identity across renderer reload, real Ctrl+C, working-copy isolation, browser confinement and stale-view mount ordering.
- Root `phase-three-skills-bridge.spec.ts`: all three native picker token/reference contracts; provider effects are explicitly synthetic, installed-native expansion is separate evidence.
- `artifacts/phase-three-integrated/native-browser-composed.png`: root inspected actual composed Windows native browser via Electron desktopCapturer after sky's native pipe was unavailable. Final theme recapture pending.

## Work ownership and boundaries

Implementation uses isolated CLI workers, max three alongside root. Backend/reasoning: gpt-6-astra high. UI and visual review: exact Claude Opus 5, expressly authorized after Fable quota failure. Current workers: themes, icon/orb/widget theme propagation, and fixes from the completed independent workspace visual critique, all exact Opus 5. Final UI corrections are integrated through9177169. Open VSX corrections are integrated as b8995d8: 66 focused tests pass on main and the unmodified default client completed live search/install of GitHub.github-vscode-theme 6.3.5; see phase-3-themes-network.md. Earlier diagnostic-only extraction is superseded by this verified client run.

The implement, Tastify, domain-modeling, computer-use and OpenAI-docs skills were applied where relevant; final code-review remains pending. No installed tdd skill was found after search, so focused red/green regressions were written directly.

Preserve unrelated untracked images `artifacts/composer-dev-live.png` and `artifacts/formatting-quality-native-menu.png`. Task-generated screenshots may be updated for final integrated evidence. Keep project-private memory, provider identities, explicit authority and uncertain delivery semantics intact. No installer publication or remote changes are authorized.

Final build isolation: an existing main-checkout `electron-vite dev --watch` process rewrites `out/`. Preserve that user session. Final production build, complete-app verification and package provenance must use an isolated worktree at the final code commit with its own output directory. Earlier main renderer checks remain checkpoint evidence, not final artifact provenance.

## Integrated verification checkpoint 7b0aec4

Isolated checkout .worktrees/phase3-verification, with its own production output. Node/web typecheck, repository lint, build, runtime verification (4 files) and notice verification (172 components) pass. Full Vitest suite: 214 files passed, 9 gated files skipped; 3,184 tests passed and 15 skipped. Skips are opt-in installed-native/provider/paste checks and two FakeProvider contract seams; no failing tests were excluded. The 13 standalone TTS/voice metrics tests also pass.

The ten Electron theme, branding, preference and visual-fix journeys all pass (1.8 minutes), with SOTTO_THEMES_E2E=1 and SOTTO_THEME_BRANDING_EVIDENCE=1. They exercise actual main/renderer IPC and settings restart, live icon/orb/widget palettes, theme halves/system/contrast/glass/editor/inspector/import/community fixtures, zero idle inspector mutation cycles, compact editor controls, native browser intersection and retained identity, failed-message recovery, short Tools headers, and retained terminal live palette/reduced motion. Open VSX live-network and native-provider evidence remain separately identified above. Root inspected the integrated Iris app/orb/widget and theme-gallery captures.

Integration caught a real missing webLinkDestination settings allowlist key. Commit 53762fa fixes persistence and adds a direct IPC regression plus the full Settings/ordinary-link/restart journey. The latter verifies external-by-default and embedded-after-saving behavior without launching a real external browser.

Independent Standards and Spec reviewers are reviewing baseline through 7b0aec4, with later changes to receive a delta review. The remaining 151 Electron journeys are in progress. Final package and independent Opus visual review remain pending.

## User naming correction and review remediation

Built-in display names are now Sotto, Rose, Fern, Tide, Copper and Dusk (4c4d36e). Their existing IDs and palettes remain unchanged, including saved selections; user custom/imported names and required T3 attribution remain intact. The initial/default Ocean palette is now displayed as Tide. Root ran 73 focused theme/settings/library tests successfully; fresh integrated named-theme captures and journeys are in progress.

The final independent reviews reported Standards: two P2 findings; Spec: three P2 findings. See phase-3-final-review.md. Git watcher activation/replacement is fixed (1272b6e, six tests passed), and history-disabled personal answer intent now retains redacted recovery identities (0c13e2b, six new regressions pass on main; worker58focusedpass). Durable structured answer drafts and the two UI findings (compact arrangement selector/native form explanation) remain in progress. The isolated broad Electron run passed128, skipped21 opt-in/platform gates, and exposed2staleexpectations; corrected workspace expectations passall4journeys. No app behavior was disabled or failed test skipped.
