# Terminal mode is removed

Accepted by Zach on October 22, 2026. Sotto is going all in on Watcher and threads, and Terminal mode, the Threads sidebar's other side, is not used. He asked for the whole feature to go, with its tests, and for no notice or migration: nobody has terminals to keep. It supersedes [ADR-0066](0066-a-terminal-agent-reports-state-through-run-scoped-hooks.md) and amends [ADR-0018](0018-terminals-run-on-node-pty.md) and [ADR-0049](0049-a-thread-pane-has-its-own-terminal-drawer.md).

## Context

Sotto had three terminals. Terminal mode's belonged to a project and took the place of the thread panes, with its own sidebar, its New terminal dialog, provider CLIs started with a model, reasoning and permission, run-scoped hooks that reported each agent's state (ADR-0066), worktrees of its own under `terminal-worktrees`, a Closed shelf, and rows and approval cards on a paired iPhone. The Tools panel's terminal and the Terminal drawer under each thread pane belong to a thread. They share the shell rule, xterm, search, links, text size, image paste and `node-pty` with Terminal mode, but none of its state.

## Decision

**Terminal mode goes, and everything only it used goes with it.** That is the Threads | Terminal control in the sidebar's top row, the Terminal sidebar and workspace, the New terminal dialog, main's terminal workspace service and its IPC, the terminal agent hooks and their helper (`terminalAgentHook.js`), the provider CLI command builders, Terminal mode's worktree home, the `terminals` window bridge, its saved sessions, and its tests. The sidebar's top row is now the mark, Add project, New thread and Collapse sidebar; the brand already pushed the actions to the row's end, so nothing moves into the gap. The pages that used to turn the remembered mode back to Threads no longer need to.

**The Tools panel's terminal and the Terminal drawer stay as they are.** They are thread features. So do the shell rule, the terminal clipboard, the menu shortcuts that let a focused terminal take its zoom chords, the `terminalFontSize` setting and every theme's terminal colours. `node-pty` and xterm stay, because those two terminals use them.

**The `terminals` host feature is retired.** No host offers it, and `terminal-approval`, `observe-terminals` and `answer-terminal` are gone from the protocol's requests. Protocol v1 is unchanged by this: the feature was offered only by the desktop's phone listener and only to a phone whose hello accepted it, so an installed iPhone that asks for it is simply not offered it and shows threads alone. Such a phone is still sent an empty `terminals` list in its shell: it clears a terminal answer it was waiting on only once a complete list leaves that terminal out, and without one it would hold the answer, and every answer on that computer, forever. The iPhone client no longer asks, and its terminal rows, approval cards and status view are removed.

**Nothing is migrated.** Terminal mode kept its terminals in memory, so there is no saved list to clear. A `terminal-worktrees` folder in the data folder is left where it is and never read, and so are the window's remembered sidebar mode (`sotto.threadWorkspace.mode`) and pane layout (`sotto.terminalWorkspace.layout`). No notice says the mode is gone.

## Consequences

- One fewer place starts provider CLIs outside a thread. Every provider run Sotto starts is a thread's, so Watcher and the thread list see all of it.
- The Owl night sky's switch colours (`--tt-owl-night-control` and `-on`) went with the switch they painted.
- The search and link journey (`terminal-search-links-zoom.spec.ts`) now runs over the Tools terminal and the drawer. The cases that only Terminal mode carried, a WebGL context loss, a thousand-match count and text size across a restart, went with it; the unit suites still cover the renderer fallback and the search addon, and `terminalPreferencesIpc.test.ts` covers the setting.
- The Omarchy journey in `linux-test-findings.spec.ts` no longer proves terminal zoom and links on Linux, since it proved them in Terminal mode. Porting that proof to the drawer is left for a forge run.
- Bringing terminals back as a project-level surface would be a new decision, not a revert: it would need its own agent states, and Watcher would have to see them.
