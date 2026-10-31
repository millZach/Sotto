# A pane's header is the Git action, Watch, one ··· menu and close

## Status

Accepted October 30, 2026, by Zach's pick B of `docs/prototypes/ui-hillclimb-desktop/pane-header-prototype.html` on the tag `prototype/ui-hillclimb-desktop` ("Watch plus one ··· menu"), with his answer the same day on the part the mock-up did not show: the Git action stays beside Watch. Issue #1828, from finding 10 of `docs/research/2026-10-29-ui-hillclimb-desktop.md`. **Number provisional until merge** (docs/agents/domain.md).

It changes an existing surface and goes straight to stable; it is not an Owl feature (ADR-0072).

Amends [ADR-0027](0027-git-the-way-t3-code-does-it.md) (where the Git action sits, and Initialize Git), [ADR-0049](0049-a-thread-pane-has-its-own-terminal-drawer.md) (the drawer's button) and [ADR-0133](0133-thread-shortcuts-are-editable-on-a-keyboard-page.md) (Zoom pane's button). The Tools toggle the Tools rail plan put in the focused pane's header (`docs/plans/2026-09-22-tools-rail.md`) becomes a row of the menu.

## Context

A pane's header carried up to eight controls: Watch, the Git action (Initialize Git in a folder without Git), Tools, the Terminal drawer, `···`, and in a split a drag grip, Zoom pane and close, with the arrangement switch on the focused pane of three or more. In a two-pane split at 1600x1000 the title, project and folder truncated to make room ("Streaming WAV st…", "works…", "Project f…"). Dragging the divider reflowed the header, and Terra pressed Initialize Git while aiming for the panel button.

The mock-up offered today's header and three variants: A, Watch with a Layout menu beside `···`; B, Watch and one `···` menu holding everything else; C, controls only on the focused pane. Zach picked B. His answer on the Git action: keep it beside Watch, so a commit, push or pull request stays one press; only the one-time Initialize Git moves into `···`.

## Decision

**1. The header.** The title, project and folder, then pinned to the right in a fixed order: the Git action, Watch, the `···` menu and, in a split, close. The Git action shows as it does today, whenever the host has read the folder and there is a quick action to show; a folder without Git shows none. Windows' own window controls, the macOS traffic lights and Linux's bare corner stay as they are, and the pane under them keeps clear of them and of the host update pill, split or not.

**2. The `···` menu (More actions).** Two parts, each in its groups, with each row's keys at its end where keys do the same from the pane:
- **The layout:** Open beside; Tools, in the focused pane; Terminal drawer (Ctrl+J), in a pane that has one; Zoom pane or Show all panes (Ctrl+Shift+M); Arrange in a single row or Arrange in a grid, with three or more panes; and Move pane left, right, up or down, one row for each neighbour the pane has. Tools and the Terminal drawer are ticked while they show. Open beside's Ctrl+Enter is a sidebar row's chord, so the pane's row shows none.
- **The thread's own:** Initialize Git, for a folder without Git, then what the menu held: Rename, Regenerate title, Continue on another provider… or machine…, Compact context, Settle (Ctrl+Shift+E) or Restore (Ctrl+Alt+R), Reconnect, and Delete thread…. Settle and Restore show their keys only in the Threads workspace, where those keys act on the focused thread.

**3. Tools is a row, and its dot moves to `···`.** The review called the panel button "split" and the mock-up drew it as Open beside; it was the Tools toggle. B leaves no button for it, so it is the menu's Tools row. While this pane's thread has agents working, a delegated thread waiting or a browser request waiting, the `···` button of the pane that lists Tools wears the dot the toggle wore, and says why in its description. The panel hands focus back to that button when it closes. This is the part of B the mock-up did not draw; if Tools should keep a button, it is the one control to add back.

**4. The title moves the pane.** The grip goes. In a split, dragging the title area moves the pane to another pane's place, as the grip did; a press that starts on a control inside it, such as the working copy, stays that control's. From the keyboard, Move pane's rows trade places with a neighbour and announce it. Opening a pane's `···` menu focuses that pane, so zooming, arranging or moving from it gives that pane the selection; the grip and the old buttons did not.

**5. Nothing moves as a pane narrows.** The controls keep their order and their place against the pane's right edge. Watch keeps its word at every pane width in the Threads workspace; beside Watcher, a narrow pane still shows the owl alone. The Git action's label still gives way below 720px, and since it is the first control, nothing else moves when it does. A pane's project, the first thing it gives up, goes below 560px instead of 720px, so both panes of a two-pane split at 1600x1000 show their title, project and folder whole.

## Consequences

- Fewer controls to aim between: a pane in a split carries three to five where it carried up to eight, always in the same places.
- Tools, the Terminal drawer, Zoom pane, the arrangement and moving a pane each cost one more press, with their keys shown in the menu to learn. Tools has no key of its own; Changes' `mod+d` still opens it on Changes.
- The Windows design captures that show a pane header change: `threads-populated`, `threads-open-running`, `threads-stopped`, `threads-search`, `threads-split-workspace`, `threads-split-focus-820`, `threads-files-unavailable` and `threads-new-thread-chooser`, in dark and light. They are regenerated on Windows, not from this change.
- Specs that pressed the header's buttons open the menu instead, through `toggleTools`, `paneMenuToggle` and `paneMenuAction` in `tests/e2e/support/sottoLaunch.ts`. `tests/e2e/pane-header.spec.ts` holds the order, the menu, the still controls, both ways of moving a pane and the minimum window.

## Alternatives

- **A, Watch and a Layout menu.** Splitting stays one press plus one, at the cost of a fourth control that reads like the menu beside it.
- **C, controls on the focused pane only.** Half the chrome in a split, but a control that appears with focus is a hover-only control in another form, and on Windows the idle pane's close would sit beside the window's own.
- **Keep the Git action in `···` too**, as the mock-up's B implied. Zach kept it out: it is the press a finished thread most often wants.
