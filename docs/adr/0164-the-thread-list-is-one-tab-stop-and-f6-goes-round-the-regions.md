# The thread list is one Tab stop with a row menu, and F6 goes round the regions

## Status

Accepted October 30, 2026, by Zach's pick A of `docs/prototypes/ui-hillclimb-desktop/thread-list-keyboard-prototype.html` on the tag `prototype/ui-hillclimb-desktop` ("Roving list, row menu"). Issue #1827, from finding 9 of `docs/research/2026-10-29-ui-hillclimb-desktop.md`. **Number provisional until merge** (docs/agents/domain.md).

Amended October 30, 2026: the collapsed rail's tiles open the row menu (issue #1909; below, "October 30, 2026 amendment: the rail's menu").

It changes the keyboard path of surfaces that already exist and goes straight to stable; it is not an Owl feature (ADR-0072). Where it touches Owl features (the Needs you card, the collapsed rail's Owl tiles, the folder peek) it changes only their keys, under their own switches.

Amends [ADR-0133](0133-thread-shortcuts-are-editable-on-a-keyboard-page.md) (Settings › Keyboard's **Fixed & elsewhere** lists four more keys), [ADR-0146](0146-the-collapsed-rail-keeps-watcher-and-a-needs-you-tray.md) (the rail's tiles are one Tab stop) and the folder peek's keys in `docs/plans/collapsed-folder-peek.md`. Keeps [ADR-0135](0135-the-threads-sidebar-opens-on-needs-you.md)'s place for the Needs you card, right after the search field. Takes [ADR-0163](0163-a-pane-header-is-the-git-action-watch-one-menu-and-close.md)'s ··· menu as the model for every menu it adds.

## Context

From Search threads, the review pressed Tab 25 times and was still in the sidebar. Every thread row and each of its hover actions (Open beside, Rename, Regenerate title, Watch, Settle) was its own stop, and so was every folder's New thread and Settle project. On the design fixture at 1600x1000, main took 51 presses to reach the composer, 44 of them in the sidebar (53 and 46 on Owl, with the Needs you card). F6 dropped the visible focus instead of moving to the pane, except between the panes of a split, where it never came back to the sidebar.

Windows' guidance is that a list keeps one Tab stop with the arrow keys inside it, and that F6 and Shift+F6 move between a window's major panes, which an app must build itself. `AGENTS.md` asks for a keyboard path that is designed rather than inherited.

The mock-up offered today's path and three variants: A, a roving list with a row menu; B, one stop per row with a row menu; C, a roving grid whose arrows walk into a row's icons. Zach picked A.

## Decision

**1. The thread list is one Tab stop.** The sidebar's project folders, their rows and the Settled shelf are one list. One of its controls holds `tabindex="0"` and every other `-1`, so one Tab enters it and the next leaves it. The control it holds is the one last focused; until the list has been focused, the thread on screen, or else the first control. A row drawn anew keeps it (`data-roving-key`), and when the row that held the focus goes, the focus follows it if it is drawn again elsewhere (an Owl rail tile moving to another part) and otherwise moves to the one now in its place (a row settled from its menu). A collapsed sidebar's list keeps its stop, so expanding it changes nothing.
- **Up and Down** move through the list's controls in the order they are drawn, **Home** and **End** go to its ends, and nothing wraps. **Enter** opens the focused thread and leaves the focus on its row, as a click does.
- **Folders and the shelf are items of the same list, with the tree pattern's keys.** **Right** opens a closed folder or the Settled shelf and steps into an open one (an empty one goes nowhere); **Left** closes an open one, and from a row steps out to its folder (from a settled folder, to the Settled shelf). They are not separate stops because a folder is how the eye groups the rows, not a place to Tab past, and Tab past a dozen folders would bring back the cost this removes.
- **The roles stay.** Rows, toggles and the shelf stay the buttons they are, with their names: a row is still a button named by its title, a toggle still says its count and `aria-expanded`. The list follows the WAI-ARIA tree pattern's keys without its `tree` and `treeitem` roles, so a screen reader's browse mode still reads each row as a button and every spec that finds a row by its name still does. Changing the roles is open if screen-reader testing asks for it.
- **Owl's lines inside the list are items too.** Keep main up to date's line, a swarm's angles and the folder peek's preview and foot are walked like rows, so nothing in the list falls out of reach. The peek still opens as the focus rests on a closed folder's toggle, but Down no longer opens it at once: Down moves on, into the preview once it shows and on out of it, where it used to stop at the preview's last row. Right opens the folder for real, as Keep open does.

**2. A row's actions are its menu.** **Shift+F10**, the **menu key** or a **right-click** anywhere on a row opens its menu: **Open** (Enter), **Open beside** (its chord, where a row offers it), **Rename** (F2), **Regenerate title**, **Watch** (ticked while Watcher watches) and **Settle** or **Restore**, each where the hover icons offer it and with the keys that do the same from the row. Settle's and Restore's keys act on the focused thread, so only that thread's row shows them. **F2** on a row renames it in place. A folder's head has its own menu the same ways: **New thread here** (with New thread's keys where they open a thread there) and **Settle project** or **Restore project**.
- The menu is the pane's ··· menu's rows and keys (`PaneMenuRows`, `menuKeyDown`): Up, Down, Home and End move, Enter and Space choose, Escape or Tab close it and hand the focus back to its row, and a press outside or the window losing the focus closes it. It opens at the pointer for a right-click and under the row for the keys, follows its row as the sidebar scrolls, and is drawn in its row but shown in the top layer, so the sidebar's edge never cuts it.
- **The hover icons stay for the pointer, out of the Tab order.** The menu is their keyboard and right-click twin, in words.

**3. F6 and Shift+F6 go round the regions.** A **region** is a part of the window F6 moves between, marked `data-region`: the sidebar, each thread pane and its composer, Tools while it is open, or a page's room beside the sidebar. A room that holds regions is not one itself, so the Threads page's workspace is a region only while no pane is open, for the empty page's New thread. F6 enters the sidebar at the thread list's stop (or the rail's, collapsed, or the search field when the list is empty), a pane at its transcript, a composer at its prompt, and anything else at its first control.
- **A split** goes round every pane, from the focused one: from the sidebar, F6 visits the focused pane and its composer, then each other pane and its composer in the order they are drawn, then Tools if it is open, and comes back to the sidebar. Shift+F6 goes the other way, so from the sidebar it reaches the focused pane's composer first. Entering a pane focuses it, as a click does. It replaces the split's own F6, which went from pane to pane and never back to the sidebar.
- **Watcher's room** has no sidebar: F6 goes round Watcher's pane and its composer, and the pane beside it and its composer while one is open.
- **A page without a composer** is two regions: the sidebar beside Dictate, Usage and Help and the room; Settings' column, entered at the open page's tab, and the page.
- F6 and Shift+F6 do nothing while a dialog is open, rather than letting the window drop the focus. **A terminal keeps F6**, as it keeps every thread shortcut (ADR-0133), since programs in it use the F keys; Ctrl+Tab already leaves a terminal.

**4. Fixed keys that stand down for dictation.** F6, Shift+F6, F2 and Shift+F10 are fixed rather than recorded, and each stands down when one of dictation's shortcuts means the same keys, as every thread shortcut does (`fixedKeyFree`). The menu key and a right-click always open a row's menu. Settings › Keyboard lists them under **Fixed & elsewhere**: Move in the thread list, Open a thread's menu, Rename the thread, and Move between sidebar, pane and composer.

**5. The collapsed rail** is one Tab stop too: Up and Down move between its tiles, Home and End go to its ends, and Enter or Space presses a tile as before. Expand sidebar and Watcher's tile keep their own stops. A tile opens its thread's row menu (October 30, 2026 amendment, below).

## Consequences

- On the design fixture at 1600x1000 and 820x560, Tab from Search threads reaches the composer in 13 presses on stable (51 before) and 15 on Owl (53), the Needs you card's two stops still first (`docs/verification/thread-list-keyboard.md`).
- A row's actions cost one more press from the keyboard (Shift+F10, then the row), in exchange for every other thread not costing six.
- The menu item's focus ring is 3px, like every other focus ring; the pane's ··· menu takes the same ring.
- The Windows design captures do not change: none of them focuses the list or opens a menu, and the list's tab stops draw nothing. The Keyboard page is not captured.
- Specs that tabbed through a row's or a folder's icons open the menu instead (`watcher.spec.ts`, `workspace-draft-and-delivery-journeys.spec.ts`), and `split-workspace.spec.ts` expects F6 to land on the next pane's transcript. `thread-list-keyboard.spec.ts` holds the walk, the menu and F6.

## Alternatives

- **B, one stop per row with a row menu.** Closest to today: five threads cost five Tabs instead of thirty, but a long list still costs one per thread.
- **C, a roving grid.** No menu: the arrows walk into a row's icons. The icons would need to name themselves when focused, and the actions would stay unnamed in words.
- **Folders and the shelf as their own stops** beside a roving list of rows. It keeps a toggle one Tab away, at the cost of a stop per folder.
- **A `tree` with `treeitem` rows.** The correct roles for the keys, but every row stops being a button, every spec and capture locator that names a row changes, and a screen reader's browse mode reads a tree differently. Kept open until screen-reader testing asks for it.

## October 30, 2026 amendment: the rail's menu

A thread's tile on the collapsed rail opens the same row menu as its row, on Shift+F10, the menu key and a right-click: the same items in the same words with the same keys, built by the same code (`useThreadMenu`) and drawn by the same `RowMenu`. The keys open it at the tile's end rather than under it, since a tile is too narrow to stand under, level with the tile's top and turned up from its foot where the window is too short; a right-click opens it at the pointer, as on a row. Escape and Tab hand the focus back to the tile, and choosing an item leaves the focus there, as on a row; a tile that goes, as a settled thread's does, hands it to the tile now in its place. The tile answers the keys its menu names: F2 renames, in the row's own field drawn beside the tile in the menu's frame, because a tile has no room to rename in place, and the focus comes back to the tile when it is done; Open beside's keys open the thread beside. Settle is the row's Settle (`useSettleThread`), worktree question included, so whatever follows a row's Settle follows a tile's. Settling the thread on screen from its tile leaves the tile on the rail, settled, as ADR-0146 keeps the focused thread there, where Settle's keys pressed with the rail showing still move on to the top open thread. On Owl, a waiting tile whose press pops its Needs you card names no keys for Open, because Enter pops the card. Watcher's tile has no menu. The Windows design captures do not change: none of them collapses the sidebar or opens a menu, and a closed menu draws nothing.
