# Phase 3 renderer and UI verification

Owner: `work/phase3-ui` (Claude Opus 5 UI worker). Tickets #49 #50 #52 #56 #57 #59 #64 #65 #68. #54 layout is owned by the separate layout worker.

Target: Windows Electron desktop, pointer and keyboard, at 1600 and 1280 wide, the 820 minimum and a short 820x560 window, light and dark, reduced motion.

## Tastify acceptance checks (written before implementation)

Concept: a daily coding workspace whose proof is moving between a live thread and its tools without losing work. The transcript leads; tools sit beside the selected work; personal chat is its own saved conversation list. Reference: the existing Crossing Threads page (artifacts/phase-two-tools-fixed, artifacts/thread-activity, artifacts/phase-two-composer-final-gaps) and T3 at d1d15c67 for request, terminal, browser and diff behavior. Carry over: transcript-led hierarchy, Bricolage headings over Manrope body, Spline Sans Mono for code and paths, one field/one ink/one accent, quiet ghost controls, 1px hairlines instead of cards.

1. Hierarchy: in every new surface the working content (terminal output, page, diff, chat transcript, request question) is the largest area; chrome is one compact toolbar row. Verify by squinting at each capture.
2. Type: no new text below 12px; controls and meaningful labels at least 14px (13px only where the existing tools panel already uses it). Terminal and diff text in the existing mono face. Verify computed sizes in captures at 1280 and 820.
3. Color: only existing tokens (`--tt-*`) and the chosen accent; diff add/remove and terminal ANSI palettes derived from the room's ink/field, readable in light and dark with every accent. Verify dark/teal and light/blue captures.
4. Copy: each control has one label; no repeated facts between a toolbar and its body; new introductory copy on any first screen within five text elements (empty states: one sentence, one action). List the counted elements per surface below.
5. Motion: reuse the existing pane/panel transitions; no new decorative animation. Reduced motion removes the running pulse animation and smooth scrolling. Verify with `reducedMotion: 'on'` capture.
6. Keyboard: every new control reachable by Tab; tab lists use arrow keys; request choices are native radio/checkbox groups; terminal takes keys only when focused and Escape-free exit via Tab is documented (Ctrl+Shift+Tab? see limitations); skill picker keeps arrow/Tab/Enter/Escape. Verify with keyboard-only journeys and focus captures.
7. States: each surface renders loading, empty, error/unavailable and recovery (Reopen, Try again, Open externally, Check again) states with one action each. Verify captures of material failure states.
8. Native browser boundary: the embedded page is a main-owned WebContentsView; captures that cannot contain it are labeled as such, never presented as a verified page render.

## Results

Rendered review on 2026-09-13, branch `work/phase3-ui` at 713e426, built with `npm run build`.

### What ran, and what stood in

| Journey | Spec | Real | Fixture (labeled) | Result |
|---|---|---|---|---|
| Changes, Terminal, Browser, per-link menu, reduced motion | `tests/e2e/phase-three-ui.spec.ts` (tools) | AppShell, renderer, preload, IPC, the production Git, PTY and browser services, a Git working copy inside the owned profile, PowerShell, a local HTTP page | The coding provider (`success` E2E scenario) supplies the Workshop thread and its link message | pass, 3 of 3 repeats |
| Start, continue, disconnect, restart, unsupported default | `tests/e2e/phase-three-ui.spec.ts` (chats) | AppShell, renderer, preload, IPC, the production personal chat service and its saved store, a restart on the same profile | The personal Codex connection (`E2EPersonalChatHost`) replies with fixed markdown and offers the `brainstorm` skill | pass, 3 of 3 repeats |
| Shared tools panel file browsing | `tests/e2e/files-panel.spec.ts` | as above | coding provider | pass |
| Activity rows, live line, restored history, minimum width, reduced motion | `tests/e2e/thread-activity.spec.ts` | as above | coding provider activities | pass (4 tests) |
| Provider skills in the thread composer | `tests/e2e/phase-three-skills-bridge.spec.ts` | as above | coding provider skills | pass |
| Terminal output across reload, Git diff containment, embedded page isolation | `tests/e2e/phase-three-tools-bridge.spec.ts` | as above | coding provider | pass (2 tests) |

Every journey runs on an owned temporary profile seeded with `onboardingComplete: true`. None reads the user's profile, and no installed native client or paid provider ran.

Unit coverage for the same surfaces:
- `tests/unit/renderer/tools/*` (38 tests)
- `personalChatsView.test.tsx` (8)
- `threadRequestSurroundings.test.tsx` (6)
- `appShell.test.tsx`

Captures:
- `artifacts/phase-three-ui/`: tools and Chats, from this review
- `artifacts/thread-activity/`: #64/#65
- `artifacts/crossing/phase3-requests-*`: request card journeys, from the requests worker

### Capture limitation: the embedded page

The browser page is a main-owned `WebContentsView` layered over the window, and Playwright's page capture cannot contain it. So:

- `browser-dom-without-native-view-1280-dark.png` and `browser-dom-820x560-*.png` show only the renderer chrome. The empty viewport rectangle in them is **not** evidence of a rendered page.
- `browser-native-page-1280.png` is the native view's own `capturePage()` of the local page ("Atlas local app" on blue).
- The journey asserts that the view's bounds equal the `.browser-viewport` rectangle and that the view's title is the page's title.
- No single image shows the chrome and the page together.

### Checks

1. **Hierarchy: pass after one fix.**
   - At 1600 and 1280 the diff, terminal output, page and chat transcript are the largest areas (`changes-diff-1280`, `terminal-1280`, `chat-conversation-1280`).
   - At 820x560 an open diff showed about four lines under a three-row file list. Fixed in d193906: below 640px of window height the list keeps one row, the selected file, and the diff takes the rest. The journey asserts that the diff is more than twice the list's height and that the selected row is whole.
   - Still open: the shared tools header wraps the working-copy path onto three lines at 820 wide. That costs the short window about 70px.
2. **Type: pass after one fix.**
   - At every capture the journeys measure each visible text element in the tools panel, Chats and menus, and fail below 12px.
   - The Changes status badges were 11px and are now 12px (d193906).
   - Measured minimums: tools 12px (path parts), Chats 12px (row times), Chats empty state 13px.
3. **Color: pass for the tokens in use.**
   - New surfaces use only `--tt-*` semantic variables.
   - Diff add and remove rows mix `--tt-success` and `--tt-error`. The terminal palette reads the room tokens and follows `data-theme`.
   - Fixed in fa71f99: xterm painted its viewport `#000` in every theme, which showed as a black band under the last row in light. The journey now asserts a transparent viewport.
   - Captures are dark and light with the blue accent only. Other accents belong to the themes worker and were not captured here.
4. **Copy: pass after one fix.**
   - The Chats first screen has four text elements: "No chats yet.", the heading, one sentence and one "New chat" action.
   - The unsupported default adds one availability sentence and a "Coordinator settings" link.
   - The terminal hint was cut to "Ctrl+Tab lea…" at 1280. It now wraps, and the journey asserts it is never clipped (713e426).
   - The Chats composer gives one reason per held state: disconnected, connecting, request pending, replying, unconfirmed.
5. **Motion: pass.**
   - There is no new decorative animation.
   - With `reducedMotion: 'on'`, the per-link menu's `animationName` is `none` (tools journey).
   - Activity rows stay static and readable at the minimum width under reduced motion (`thread-activity` minimum test).
6. **Keyboard: pass.** Each item below was exercised by keyboard alone:
   - The "Tools" toggle opens the panel with focus on its tabs, and arrow keys move between tabs.
   - The changed-files listbox opens a diff with Enter, and "Close diff" returns focus to that row.
   - The terminal takes typed input once focused, and its hint names Ctrl+Tab to leave.
   - The address bar opens the typed address with Enter.
   - Shift+F10 on a transcript link opens the menu with focus on its first item. Escape returns focus to the link, and Enter opens the page in a new tab.
   - In Chats, "New chat" focuses the composer and Enter sends. Typing `$brai` then Enter inserts `$brainstorm`.
   - Request choices are keyboard-reachable and uncovered at 820x560 (requests worker journey).
7. **States: pass in unit tests, partial in rendered captures.**
   - Rendered: Chats empty, conversation, skill picker, disconnected and unsupported default; tools diff, terminal, page and "page steps aside".
   - Unit-verified only:
     - Changes: loading, not a repository, too large, and Try again.
     - Terminal: unavailable, ended, and Reopen.
     - Browser: load failure and Open externally.
     - Chats: pending, unconfirmed with Check again, refused answer, and personal request cards.
   - The personal chat fixture has no requests or activities, so personal request cards were never rendered in the complete app.
8. **Native browser boundary: pass.**
   - See the capture limitation above.
   - While a menu is open the view detaches (0 host views), and the panel says "The page steps aside while a menu or dialog is open."
   - Escape reattaches the view with the same bounds.

### Known gaps for integration

- **Requests spec assertion.** `tests/e2e/phase-three-requests.spec.ts:260` (requests worker) expects "Jump to latest" to be visible at scrollTop 0 in 820x560 with the approval card in view. 2e12d20 deliberately hides Jump while a request card reaches its bottom band, so that one assertion now fails. With only that line changed to `toHaveCount(0)`, the whole spec passes. I checked this with a throwaway copy that was not committed.
- **Old toggle name in layout tests.** Layout-owned tests still query the header toggle as 'Files', but it is now named 'Tools': `tests/unit/renderer/splitWorkspace.test.tsx:294-295` and `tests/e2e/files-panel-split.spec.ts:115,132,186,198`.
- **Stale request tests.** `tests/unit/renderer/threadsView.test.tsx` has 2 stale request tests. They fail on the baseline too (see requests-result.md), so this branch did not cause them.
- **Terminal dependencies.** Main needs `npm install` for `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0 (8dddec4). `scripts/generate-notices.mjs` does not know about the hand-written native terminal notices section.
- **Provider name casing.** The backend's unsupported-reasoning reason names the provider by its lower-case id ("claude"), and Chats shows it verbatim.
