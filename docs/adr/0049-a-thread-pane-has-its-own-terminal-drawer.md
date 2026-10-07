# A thread pane has its own terminal drawer

## Status

Accepted October 3, 2026. The owner asked for T3 Code's terminal, which "starts a terminal in the project you are in, in the bottom 1/3 of the thread". From `docs/prototypes/frosted-terminal-prototype.html` they chose variant A, a drawer below the composer with its shells as tabs. They also chose one drawer inside each pane over one across the workspace, shells separate from the Tools panel's terminal over sharing them, Ctrl+J as the shortcut, and a see-through drawer under a Frosted window (ADR-0048).

## Context

Sotto already had two terminals. The Tools panel's terminal belongs to a thread's working copy and opens in the panel at the side. Terminal mode's terminals belong to a project and take the place of thread panes (ADR-0018). Neither sits under the conversation, where T3 Code keeps it.

## Decision

Every thread pane's header carries a **Terminal drawer** button, after the Tools button, except for a thread on a paired host. That thread's working copy is on the host, and Tools already says its terminal is there. A drawer placed before Tools moved under the pointer when a click focused its pane and the Tools button appeared there. The drawer opens across the bottom third of the pane, below the composer, and starts a shell in the thread's working copy when it has none. Each thread remembers whether its drawer is open and how tall it is, in `localStorage` under `sotto.paneTerminal`.

The drawer's shells run in the same main-process service as the Tools panel's terminal, which now records a **place** for each session, `tools` or `drawer`. Listing, creating and following a session all happen within one place, so neither surface ever shows the other's shells. They still share the 32-session limit, and a running drawer shell keeps its worktree from being reclaimed like any other. A record saved before places existed reads as `tools`.

Ctrl+J, or Cmd+J on a Mac, toggles the drawer of the pane the key lands in, or of the selected thread's pane when that pane is on screen. It acts on nothing in Terminal mode or on another page. A drawer's own terminal passes Ctrl+J to the page instead of the shell. The Tools panel's terminal and Terminal mode's terminals keep Ctrl+J for their shells. When the dictation hotkey is Ctrl+J, the drawer leaves the chord to it and the button's title stops naming it. Escape and every other key belong to the shell, so a drawer is hidden with its button, its Hide terminal drawer control (a panel-closing icon, unlike the tab's X, which ends a shell), or Ctrl+J. Hiding from inside the drawer puts focus back in the pane.

Under a Frosted window the drawer paints `--tt-frost-terminal`, a little more solid than the room. Its terminal draws its background at zero alpha, so xterm still measures text contrast against the theme's terminal colour.

## Consequences

- Each shell starts at an estimate of the drawer's width, since a shell's first prompt is hard-wrapped at the size it starts with. Without that, a narrow split pane cut the prompt off.
- Ctrl+J is a line feed in a shell, and a drawer's shells never receive it; Enter does the same job there. The other terminals still receive it.
- Hiding a drawer never ends its shells, so closing the last tab is the only way a drawer ends one.
