# The Threads sidebar groups open threads by status

## Status

Accepted November 10, 2026. Zach asked for the desktop sidebar to read like the iPhone's Threads page, which he finds "super clear where everything stands", and to change it "from being project based to thread status based". He picked from `docs/prototypes/sidebar-status-groups-prototype.html`, variant D, the same day: the iPhone's groups, the desktop's rows (variant B), and the Needs you card left as it is. It goes **straight to stable**, and the Needs you card (`needs-you-queue`, ADR-0135) goes to stable with it, his call the same day. **Number provisional until merge** (docs/agents/domain.md).

Reverses the project-folder default of `docs/plans/thread-sidebar.md` (prototype A, September 19, 2026), which stays as the **By project** choice. Amends ADR-0135, ADR-0164, ADR-0167 and ADR-0175 where they speak of folders, each in a note of its own. ADR-0146's collapsed rail is unchanged: it keeps its project trays whichever way the list is grouped, Zach's pick.

## Context

The iPhone has listed threads by status since ADR-0039: what waits on you, then what is working, then the rest, with Snoozed and Settled folded after them (ADR-0151, `FocusThreads` in SottoCore). The desktop listed them under project folders, each folded shut when Sotto starts, so seeing what was working meant opening folders one by one. Needs you (ADR-0135) had already gathered what waits across every project; what was working and what had finished were still split by project.

## Decision

**1. A choice, and status is the default.** Settings › Threads › Sidebar has **Group threads in the sidebar**: **By status** or **By project** (`threadListGrouping`, `status` or `project`). A saved settings file without it reads `status`, so everyone who updates opens on status groups. By project is the sidebar as it was, folders, peek and Keep main up to date's line included.

**2. The iPhone's groups, under the card.** By status, the open part of the list is, in order:

- the **Needs you** card, exactly as ADR-0135 has it, above the groups. It is a note to read rather than a group to fold, Zach's words, so it is not drawn as a group;
- **Working now**: open threads with a turn, compaction or background work running, on a provider Sotto can reach;
- **Recent**: every other open thread.

Then the **Snoozed** and **Settled** shelves, folded, as before. The rule is the iPhone's (`FocusThreads.init`): a working thread whose provider is out of reach is in Recent, saying Disconnected, not in Working now. Two differences are the desktop's and stay: a failed turn nobody has seen stands in Needs you with Dismiss (ADR-0092, ADR-0135), where the iPhone puts it in Recent; and the iPhone's Needs you is a group, the desktop's a card.

**3. Every thread keeps a row.** A thread standing in Needs you keeps its row in Recent, reading **↑ In Needs you**, as its folder row did (ADR-0135, November 5 amendment), so settling, renaming and its row menu stay where they were.

**4. Order.** Inside each group, rows on a reachable provider first, then the one that last moved, its last message or the start of its running turn, whichever is later, as the iPhone orders them (`ThreadGroups.latest`). A reply streaming in therefore does not reorder the group. A row keeps its group while it is being renamed and while a Settle's held gap stands (ADR-0167), so a half-typed name is not drawn anew and nothing slides under a still pointer.

**5. The row names its place.** The desktop's row stays as it is (ADR-0135's resting rows, one-line names), and its second line leads with the **project's name**, then a **badge for a remote computer** when the thread runs on one, then what it is doing at the line's end. A thread on this computer names no computer. A resting row's one line keeps only its name and time; its project is in its description. There is no **All computers** menu, Zach's pick.

**6. The heads fold.** Each group's head says its name and count and folds it, as a folder's head does, in the muted ink of a heading. A group starts open and stays as the user leaves it while the window lives (the folders' session store). A search opens every group. An empty group is not drawn. With no open thread but settled or snoozed ones the list says **All caught up.**; with no thread at all it says nothing, since the room says it once (#1834).

**7. The keyboard is the thread list's.** The groups are tree items of the one thread list (ADR-0164): Up, Down, Home and End walk heads and rows, Right opens a group and Left folds it or steps out of a row to its head. Moving between threads by chord follows the sidebar's order: Working now, then Recent.

**8. The shelves stay.** Snoozed and Settled hold the same project folders as before, so **Restore project** and a settled project's own rows are where they were.

## Considered

Four ways in the prototype. **A**, the iPhone's own rows, with a provider · project · computer line and times such as "8 min ago"; **B**, the desktop's rows under folding group heads; **C**, Needs you and Working now as cards that also say the agent's last line, over a dense Recent; **D**, B under the Needs you card. Zach first chose Needs you as a group of rows, then on seeing B kept the card. He chose the computer on the row over an All computers menu, project trays on the rail over status trays, and the desktop's rule for failed turns over the iPhone's.

## Consequences

- What is working is seen at a glance on every computer, and a project is a word on a row rather than a place to open. Starting a thread in a given project now goes through the top **New thread** button's project chooser, or By project's pen on a folder.
- Folder-only parts have no place by status: a folder's menu (**New thread here**, **Settle project**), the folder peek (Owl), and Keep main up to date's line under a project (Owl). By project keeps all three.
- With Needs you on stable, stable's **N need attention** line and the folders' dots go (ADR-0135, Owl first): the card says what waits on every computer.
- The rail is grouped by project while the list is grouped by status. Zach chose that over a rail that follows the list.
