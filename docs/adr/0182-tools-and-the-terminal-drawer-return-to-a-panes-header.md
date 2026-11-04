# Tools and the Terminal drawer return to a pane's header

## Status

Accepted November 2, 2026, by Zach's review of `docs/prototypes/pane-header-tools-terminal/index.html` on the tag `prototype/pane-header-tools-terminal`. **Number provisional until merge** (docs/agents/domain.md).

It fixes an existing surface and goes straight to stable; it is not an Owl feature (ADR-0072).

Amended by [ADR-0183](0183-a-paired-hosts-thread-opens-its-terminal-over-ssh.md): on Owl, the greyed button of decision 4 opens a real terminal over SSH.

Amended by [ADR-0177](0177-the-council-puts-one-question-to-threads-on-several-providers.md) on November 3, 2026: on Owl, while the Council is on, a Council button sits right after Watch, before Tools, and the drawer has a Council tab before its shells.

Amended November 4, 2026, by the design pass on the shell: decision 5 is reversed (see the amendment at the end).

Amends [ADR-0163](0163-a-pane-header-is-the-git-action-watch-one-menu-and-close.md): this replaces its decision 3 and the Tools and Terminal drawer rows of its decision 2, and adds both buttons to its decision 1. It also amends [ADR-0049](0049-a-thread-pane-has-its-own-terminal-drawer.md), since a thread on a paired host now shows the drawer's button.

## Context

ADR-0163 moved Tools and the Terminal drawer into the `···` menu, and said of Tools that if it should keep a button, it was the one control to add back. Zach found both hidden: "we recently compacted the top bar of but it ended up hading the tools and the terminal view that should open below a thread." On a window about 1920px wide, his thread's name took most of the bar, and no Terminal symbol showed at all.

The second part had another cause. Sotto hides the drawer on a thread on a paired host, because its terminal is on that machine (ADR-0049), and that is how he views forge's threads from his laptop. Putting the old button back would have left those threads with no symbol.

## Decision

**1. The buttons.** The fixed order is now the Git action, Watch, Tools, the Terminal drawer, `···` and, in a split, close. They are the symbols they were before ADR-0163, a panel with a right-hand strip for Tools and one with a bottom strip for the drawer. Neither is in the menu any more; Open beside stays there. Ctrl+J still shows and hides the drawer. Tools' dot and its words go back on the Tools button.

**2. Tools stays beside the thread.** It opens where it always has, on the right, or over the thread in a narrow window. Only the drawer opens below. Zach's first words described both as opening below the thread; shown the difference, he kept Tools beside.

**3. Every pane has both.** Tools was once only on the focused pane. Now it would shift the Git action and Watch sideways as focus moved, under a pointer that was on its way to press them, which ADR-0163 removed. So every pane in the Threads workspace carries the same buttons. Tools follows the focused thread, so in a pane without focus, the press that focuses the pane opens the panel on that thread and never closes it. A press from a pane that holds focus shows or hides it. Beside Watcher a pane still has neither.

**4. A thread on a paired host.** The drawer's button shows, greyed, and says "This thread's terminal is on forge. Open it there." It opens nothing, and stays reachable from the keyboard so the reason can be read, as the disabled Git action does. A real terminal for these threads is a separate job with its own decision (see Consequences).

**5. The name gives way first.** It cuts off only as far as it must to fit what is left of the row, so it stays longer in a wide window, and the buttons always fit. Hovering shows the full name. Below a floor it stops, and the project and branch give way instead. That floor is the smallest of 14em, 30% of the pane and the name's own width, so a short name is never held open with a gap after it. At 720px or narrower, the row shares its space as it did.

## Consequences

- A pane carries up to six controls where ADR-0163 left up to four. In the narrowest pane, 400px, the name gets very short, since the two buttons need the room: about 50px in the mock-up's measure, where it had about 95px.
- The name's floor uses CSS `calc-size()`, the one way to say "this minimum, or the content's width if that is smaller". Electron's Chromium has it, and nothing else draws this stylesheet.
- `PaneMenu` no longer has a dot on its button. `ThreadPaneMenu` and `toolsMenu` are gone, and `ToolsToggle` and `PaneTerminalToggle` are the buttons.
- The Windows design captures that show a pane header change: `threads-populated`, `threads-open-running`, `threads-stopped`, `threads-search`, `threads-split-workspace`, `threads-split-focus-820`, `threads-files-unavailable` and `threads-new-thread-chooser`, in dark and light. They are regenerated on Windows, not from this change.
- Zach also asked for a working terminal on paired-host threads, next. That is a larger job, since the host has no terminal surface for a client, and ADR-0111 retired the feature that had one.

## Alternatives

- **Hide the button on a paired host, as before ADR-0163.** Zach would still see no Terminal symbol on the threads he was looking at.
- **Open Tools below the thread**, as his first words read. A new layout for a panel built to stand beside the panes; he kept it where it was.
- **A fixed floor on the name.** The prototype's first version did this, and Zach caught the gap it left after short names. Capping the project and branch instead cut them off in wide windows where there was room. A floor estimated from the name's character count, which the prototype he approved used, still left a small gap after narrow letters, so the build measures the name itself.

## November 4, 2026 amendment: the name is served first

Decision 5 gave the name the row's leftovers, and with Tools open or two panes side by side that left "Thread…" at 1600 wide and "Thre." at 820, beside a whole project and branch. Reviewers comparing Sotto with three other apps named it the header's worst fault, and the name is the one thing in the row that tells panes apart.

The buttons still always fit, in the same order and places. Of the rest, the name now comes first: whole if the row can hold it, cut only if it cannot, and capped at 62% of a wide pane (or 22em) so a very long name leaves room for where the thread works. Everything else stands in what is left, in a box that composes by its own width (the container `pane-where`), and gives way a whole part at a time rather than as a cut-off word: the workspace, then the project, then the working copy, then the branch, then the pull request's number. The fixed widths this replaces (720px and 560px for the pane, 980px for the window) knew only the pane, not how long its name is. An open list stays shown whatever the room, so the chords that open the branch and workspace lists keep working.

In a pane under 720px, Watch is its owl alone, with its name unchanged for a screen reader. Beside the branch controls the working copy shows its icon alone, since both named the branch. A new thread's header leaves the project to its greeting, and its greeting leaves the branch to the branch controls.
