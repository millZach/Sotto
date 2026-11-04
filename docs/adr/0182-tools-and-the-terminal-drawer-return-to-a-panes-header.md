# Tools and the Terminal drawer return to a pane's header

## Status

Accepted November 2, 2026, by Zach's review of `docs/prototypes/pane-header-tools-terminal/index.html` on the tag `prototype/pane-header-tools-terminal`. **Number provisional until merge** (docs/agents/domain.md).

It fixes an existing surface and goes straight to stable; it is not an Owl feature (ADR-0072).

Amended by [ADR-0183](0183-a-paired-hosts-thread-opens-its-terminal-over-ssh.md): on Owl, the greyed button of decision 4 opens a real terminal over SSH.

Amended by [ADR-0177](0177-the-council-puts-one-question-to-threads-on-several-providers.md) on November 3, 2026: on Owl, while the Council is on, a Council button sits right after Watch, before Tools, and the drawer has a Council tab before its shells.

Amended November 4, 2026, by Zach's pick of variant B: decision 5 now serves the name first (see the amendment at the end). His words of November 2 stay in the record below.

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

## November 4, 2026 amendment: the name stays readable longer

Zach chose this. On November 2 he asked: "shorten the name of the thread down, if you hover with mouse it will show full name and add the tools and terminal below thread symbols back next to the watch symbol". Decision 5 built that, and it cut names to "Thread..." beside a whole project and branch, once Tools was open or two threads stood side by side. On November 4 he tried both answers in the design pass's prototype `sotto-council/prototypes/thread-names/index.html`, kept outside the repository, and picked B. The prototype's stylesheet is Sotto's own at commit `b51c58162`.

**What changed.** This replaces decision 5.

- The name is served first: whole if the row can hold it, and only then cut. Hovering still shows the full name. A very long name stops at 62% of the pane or 22em, whichever is more, so a wide pane keeps room for where the thread works.
- The buttons stay where he put them, in the same order, and always fit.
- Everything else stands in what is left of the row, in a box that composes by its own width, and gives way a whole part at a time rather than as a cut-off word: the workspace, then the project, then the branch, then the pull request's number. An open list shows whatever the room, so the chords that open one keep working. They all stay in Tools and the Git action.
- The name's floor is the smaller of 3em and the name's own width, so a short name has no gap after it. The old floor was the smallest of 14em, 30% of the pane and the name's width, with a flat 3em at 720px or less, which left 8px after a very short name in those panes.
- The floor is never more than the row has left beside the buttons. On the prototype, the right pane at 1280 with two threads, under the window's own controls, had too little room for even 3em, so the name ran under its buttons ("Rep"). This build cuts it there with an ellipsis ("Re…"). Zach named that fault as one to end, so here the build differs from the page.
- Watch drops to its owl below a 720px pane, with its name unchanged for a screen reader. Beside the branch controls, the working copy shows its icon alone, since both named the branch. A new thread's header leaves the project to its greeting.
- Tools keeps today's 56% width.

**Why.** The name is the one thing in the row that tells panes apart. With Tools open or two threads side by side, decision 5 spent the row on a project and branch that Tools and the Git action already say.

**What it costs.** With a long name in a narrow pane, the project, the branch and the number can all leave the row where decision 5 kept part of them, and Choose branch loses its button. Its chord still opens it. Below a 720px pane Watch has no word.

The Consequences' line on `calc-size()` still holds. The floor also reads the title's own width, so the title is a size container, and the name's cap reads the pane's width through the registered property `--pane-width`.
