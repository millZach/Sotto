# Phase 3 implementation and verification

All ten Phase 3 tickets are implemented locally, together with the requested desktop theme system and theme colors on Sotto's in-app mark, voice sphere and floating widget. Implementation baseline: `bf500b42f91cfc1bd198c2d75d62ee48ef4232a8`. Delivery is local commits on main and a verified Windows application directory. No push, issue updates, publication or release is authorized; #24 remains a separate release gate.

## Deliverables

| Ticket | Implemented behavior | Evidence |
| --- | --- | --- |
| #49 | Claude native activity, subagent projection, event ordering and reconnect | [Providers](phase-3-providers.md) |
| #50 | Grok ACP activity, subagent projection, retained history and stable stream identity | [Providers](phase-3-providers.md), [backend audit](phase-3-backend-audit.md) |
| #52 | Complete native questions/context, free text and exact once-only permissions; durable answer recovery without replay | [Requests](phase-3-requests.md), [answer recovery UI](phase-3-draft-recovery-ui.md) |
| #54 | Three-pane bottom span, four-pane grid, row dividers, more panes, retained arrangement and zoom | [Layouts](phase-3-layout.md) |
| #56 | Real retained PTY terminals, focus/resize/hide/reopen, Windows Ctrl+C and live theme updates | [Tools](phase-3-tools.md), [Windows package](phase-3-packaged-windows.md) |
| #57 | Retained isolated HTTP(S) browser, pinning, external links by default and saved destination preference | [Tools](phase-3-tools.md), [UI recovery](phase-3-ui.md) |
| #59 | Actual working-copy Git changes, diff/refresh/read position, copy/reveal and honest unavailable states | [Tools](phase-3-tools.md), [review corrections](phase-3-final-review.md) |
| #64 | Claude native skill catalog, scope/precedence, availability and expansion | [Providers](phase-3-providers.md) |
| #65 | Grok native catalog and expansion, with truthful unsupported states | [Providers](phase-3-providers.md) |
| #68 | Durable project-free Codex chats, global memory, stable provider identity, drafts/history/restart and no automatic delegation | [Chats](phase-3-chat.md), [storage recovery](phase-3-chat-recovery.md) |
| Themes | Mode previews; independent light/dark palettes; create/edit/duplicate/delete; local import/export and Open VSX; contrast/glass; themed mark/orb/widget | [Themes](phase-3-themes.md), [branding](phase-3-theme-branding.md), [network](phase-3-themes-network.md) |

## Theme requirements

The standalone accent picker is replaced by the reference's desktop theme capability. Built-in display names are **Sotto, Rose, Fern, Tide, Copper and Dusk**. Stable internal IDs and palettes remain unchanged, so existing selections survive the rename; custom/imported names are preserved. New or migrated selections use Tide for both halves, while existing mode and subsequent selections remain intact.

The in-app Sotto mark and voice sphere use the live palette. The widget uses the saved palette corresponding to its OS-resolved light/dark mode, including its mark and voice visualization. Taskbar, tray and installer image assets are static; these are not represented as dynamically themed.

Reference: the user's T3 Appearance screenshot and T3 Code source at `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`. Required MIT attribution to T3 Tools Inc. remains in source and notices. Local T3/VS Code import/export and Open VSX apply to this desktop product; a server publication CLI and mobile-specific controls do not.

## Acceptance and verification state

- [x] All ten implementations integrated, with focused red/green regressions for material findings.
- [x] Own theme names and palette propagation verified in actual Windows Electron journeys and inspected captures.
- [x] Independent Standards and Spec reviews: zero open findings through `e5d0a53`; separate reports and resolved findings are recorded in [final review](phase-3-final-review.md).
- [x] Full repository suite at `17d8f0f`: **3,252 tests passed**, 15 existing gated skips; 223 files passed, 9 gated files skipped. Subsequent answer-remount correction: 49 focused request tests passed; independent Spec reviewer reran all 16 recovery tests successfully.
- [x] Build, node/web typecheck and repository lint pass at `387cbb8`. Runtime verification covers four files; notices cover 172 components.
- [x] **29 integrated Electron journeys passed** at `387cbb8`, including full-process answer recovery/restart, themes/branding/widget, native form context, compact arrangements, browser/editor intersection, retained terminal updates and link preference persistence. [Exact build and capture hashes](../../artifacts/phase-three-delivery-checks/verification.json).
- [x] Independent Opus 5 rendered reviews inspected normal and minimum Windows sizes, light/dark/system, pointer/keyboard and reduced motion. Root also inspected integrated captures. [Latest bounded review](../../artifacts/phase-three-delivery-review/visual-review-result.md).
- [x] Theme-editor focus correction `e5d0a53`: 41 focused tests pass; all six affected Electron journeys pass, including Edit restoration at 1600/1280/820. The independent Opus finding's four Create/Duplicate close paths pass in actual Electron with focus back on their opener. [Captures and exact output hashes](../../artifacts/phase-three-focus-review/verification.json).
- [x] Final Windows package verified at `707b253`: exact production dependency inventory, source/build/ASAR provenance, native PTY, SQLite migration/FTS, normal startup and installed audio worklet. The delivery copy matches all 259 files. [Package evidence](phase-3-packaged-windows.md).
- [x] Final evidence saved for local delivery. No remote actions performed.

The final package retains the same 84 application artifacts and build hash exercised by the six final Electron journeys at `e5d0a53`. The sole subsequent change, `707b253`, adds the already-used `node:zlib` community-theme compression builtin to the explicit release inventory, with five passing regressions. Exact-list and builtin-availability enforcement remain intact. Node/web typecheck and repository lint pass at `e5d0a53`; the two inventory files also pass scoped lint.

The initial broad Electron matrix passed 128 journeys with 21 existing opt-in/platform gates skipped. Two stale workspace expectations were corrected and all four affected journeys passed. Intermediate full-suite failures were investigated: the synthetic Claude acknowledgement passed all 16 safety tests on isolated rerun; Windows Git fixture cleanup received bounded retries while its child's cwd handle is released. The later complete 3,252-test run passed both. No failing tests were removed or skipped to obtain the result.

## Rendered design checks

Target: the existing Windows Electron interface, typical 1600/1280 widths and minimum 820x560, pointer and keyboard, light/dark/system and reduced motion. The transcript remains dominant; short-window actions remain reachable. The reference's mode previews and three-by-two dual-palette gallery are retained, with separate selected-half rings and badges. Long custom names receive two lines plus their full tooltip; actions wrap above them. The minimized editor reserves footer space, and native browser composition was inspected with Electron desktopCapturer rather than inferred from a renderer-only screenshot.

Appearance's first viewport is task-led: heading, one introductory sentence, Color scheme label, and the three necessary mode labels. Theme names/actions and contrast/glass labels enter as the page scrolls. These are required selection controls, not decorative copy. Duplicate permission instructions were removed. Saved-answer recovery states the delivery consequence once, then shows original questions/answers and Copy/Discard actions; it never creates new sending authority or overwrites a newer composer draft. Detailed per-size observations and limits are retained in the linked Opus reports.

## Scope and delivery limits

Installed Claude and Grok activity/catalog/expansion and a native Codex personal turn/resume were exercised separately from deterministic fixture journeys. Live subagent execution was not spawned; projection is covered by source and fixtures. Real Windows PTY, Git and retained WebContentsView paths were exercised. Some paste/provider/installed-native checks remain explicitly opt-in. macOS packaging and native behavior are unverified on this Windows machine; #24 and publication remain separate.

UI builders and critics used exact Claude Opus 5 as requested; backend and independent code reviewers used gpt-6-astra/high CLI workers. The implement, Tastify, domain-modeling, computer-use, OpenAI-docs and code-review skills were applied where relevant. No installed tdd skill was found after search; focused red/green regressions were written directly.

Final production output and packaging use `.worktrees/phase3-final`, preserving the user's existing main-checkout dev watcher. Verification source/build checkpoints are recorded explicitly rather than treating earlier captures as final package evidence. Unrelated user images `artifacts/composer-dev-live.png` and `artifacts/formatting-quality-native-menu.png` are preserved and excluded from task commits.
