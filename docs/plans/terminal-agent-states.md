# Terminal agent states (#883)

The owner chose variant B of `docs/prototypes/terminal-agent-state-prototype.html` on October 9, 2026. Keep that historical prototype unchanged. ADR-0066 governs behaviour, including its correction to the prototype: every pane on screen counts as viewed, focused or not.

## Acceptance checks

- Main owns run-scoped state, hook identity, live-screen evidence and the ephemeral unread mark.
- Needs you across projects, Working, other terminals by project, then Closed. Just finished uses the thread dot and bold title. Only Needs you adds a thin pane-header edge.
- A visible split pane earns no unread completion; hidden, zoomed-out, minimised and tray panes do not count. Viewing clears an existing mark. Plain shells keep their output-based labels.
- Hooks use private run-only configuration, authenticated bounded loopback frames and the packaged helper. Native terminal answers remain native.
- Unit derivation/order tests, real fake-CLI hook integration, and an Electron journey through every state.
- Inspect light/dark and reduced motion at 1600x1000, 1280x800 and 820x560. Keep screenshots and a verification note.
- Update README, guide and glossary. Run the four CI gates and affected Playwright specs. Review standards and spec separately, then commit locally. Do not push or open a PR.

## Current state

Dependencies installed with `npm ci`. Main, hook and renderer focused tests passed. The actual Electron journey and all five affected specs passed six cases; screenshots were inspected at all six size/theme combinations. PowerShell notify quoting, stale Grok ready-screen completion and narrow-sidebar label clipping were fixed and checked again. Design captures were regenerated deliberately; incidental differences outside Terminal mode were restored after inspection. The verification note records retained evidence, source-backed screen compatibility and platform limits. The final CI gates and independent two-axis review remain before closing the branch.
