# Terminal agent states (#883)

The owner chose variant B of `docs/prototypes/terminal-agent-state-prototype.html` on October 9, 2026. Keep that historical prototype unchanged. ADR-0066 governs behaviour, including its correction to the prototype: every pane on screen counts as viewed, focused or not.

## Acceptance checks

- Main owns run-scoped state, hook identity, live-screen evidence and the ephemeral unread mark.
- Needs you across projects, Working, other terminals by project, then Closed. Just finished uses the thread dot and bold title. Only Needs you adds a thin pane-header edge.
- A visible split pane earns no unread completion; hidden, zoomed-out, minimised and tray panes do not count. Viewing clears an existing mark. Plain shells keep their output-based labels.
- Hooks use private run-only configuration, authenticated bounded loopback frames and the packaged helper. Native terminal answers remain native.
- Unit derivation/order tests, real fake-CLI hook integration, and an Electron journey through every state.
- Inspect light/dark and reduced motion at 1600x1000, 1280x800 and 820x560. Keep screenshots and a verification note.
- Update README, guide and glossary. Run the four CI gates and affected Playwright specs. Review standards and spec separately. After every gate passes, push this branch and open a PR against feat/terminal-agent-state-adr with Closes #883. Never merge.

## Review remediation and final delivery

The October 9 finish request supersedes the earlier local-only handoff and authorizes one fresh full-suite run, pushing this branch and opening its pull request after all gates pass. The approved historical variant B prototype remains unchanged.

- [x] Run `npm ci` in this worktree with its own dependencies.
- [x] Fix historical approval menus beneath a draft and selection changes to No.
- [x] Recognize Codex's native empty-composer placeholder and use it in the fake CLI.
- [x] Refuse stale cancellation and isolate permission sockets by turn.
- [x] Protect new Codex submission reservations against earlier notify callbacks.
- [x] Settle successful unsupported-version completion to conservative Idle without an unread mark.
- [x] Exclude fenced transcript status examples from screen evidence.
- [x] Preserve terminal row/action keyboard focus across group changes, including returning to a collapsed project; respect focus moved elsewhere.
- [x] Reproduce each reported defect before its fix and pass its regression afterward. The initial focused run passed 190 tests in eight files; later state corrections pass 116 regressions.
- [x] Fix follow-up stale permission, historical failure, partial redraw, notify visibility and invalidated-frame findings.
- [x] Trace the affected app failures to coalesced native redraws, draft publication ordering and delayed Claude hooks; preserve both completion/submission orders with matching-turn proof.
- [x] Complete the final CI gates and affected Electron journeys on this revision.
- [x] Resolve the fresh independent Standards and Spec reviews.
- [x] Inspect final captures and record exact results in the verification note.
- [ ] Push and open the requested pull request; leave it unmerged.

The design pass's full-width attention edge, accessible pane/tab names, empty-folder wording and stable unknown-version note are retained. Its completion timeout is checked again in the native fake-agent journey. The existing xterm scrollbar and extra compact-tab state decoration are outside #883; the sidebar remains the state navigation surface.

Final gates at `2fe9391cf`: typecheck, lint, notices and build exit 0; six Electron cases passed; the single full run returned 9399 passed | 222 skipped (9621), across 628 passed | 51 skipped (679). All eight supplied findings and the additional review/redraw findings have fixes and regressions. The final verification note records the earlier failed attempts and compatibility limits. Push and PR creation are the only remaining delivery actions.
