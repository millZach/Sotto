# Pages switch from the keyboard

## Status

Accepted October 28, 2026. The owner asked for keys that switch between Dictate, Watcher, Threads, Usage and Settings, chose their defaults and their place on Settings › Keyboard, and picked from `docs/prototypes/page-shortcuts-prototype.html`: A for a clash (refuse and name the holder, as today), rows hidden for pages a build or setting leaves out, and focus on the lit room tab after a room opens. Straight to stable, not an Owl feature. Amends [ADR-0133](0133-thread-shortcuts-are-editable-on-a-keyboard-page.md) decision 1's group list and decision 2's field. **Number provisional until merge** (docs/agents/domain.md).

## Context

The room switch and the page links were reached only by pointer or by tabbing to them. Thread shortcuts (ADR-0133) already gave threads editable keys that work only while Sotto's window holds them, with a recorder, refusals in words and one settings field.

## Decision

1. **Five page shortcuts, Ctrl+1 to Ctrl+5 (⌘ on a Mac).** Dictate, Watcher, Threads, Usage and Settings, numbered in the order the room switch and page links draw them. They are read from the window's keys like every thread shortcut, never registered with the system, and answer only once first-run setup is finished. Memory and Help get none.
2. **The same machinery, not a second one.** The ids join `THREAD_SHORTCUT_IDS` (`src/shared/threadShortcuts.ts`), so their choices live in `threadShortcuts`: a row left out follows its default, a row set to null has no shortcut. They keep every thread shortcut's rules (`threadChordPressed`): a press works from a text box, stands down for dictation's keys, in a terminal and under an open dialog, and keys typed into Sotto's browser never reach the window.
3. **A Switch pages group first on Settings › Keyboard.** Its rows record, reset and remove as the other groups' do, and a clash is refused naming the row or key that holds the keys. A page the build or the settings leave out (Watcher and Usage while their Owl features are off, Dictate while dictation is off) shows no row, answers nothing, keeps its saved keys, and does not hold them against another row. Watcher and Usage have both been sent to stable, so today only Dictate can leave; the prototype's note that stable shows neither row was mistaken. The rule stays for any build that holds one back.
4. **A press does what the page's own control does.** Dictate, Watcher and Threads open as a room tab press does, and focus lands on that room's lit tab, as a click on the tab puts it there, the room already open included. Usage lands on its page link, as a click on the link leaves it. Where no such control is on screen (the sidebar folded to its rail, or Settings, which draws no link to itself), focus goes to the page's main room instead of the document. The room tabs and page links name their page shortcut in their title and `aria-keyshortcuts`, from the saved choice, as ADR-0133 decision 2 asks of every control a shortcut stands for.
5. **A saved shortcut on a page shortcut's keys keeps them.** Settings refuses a clash only among the rows it shows, so two ways lead to one: a thread shortcut saved on a digit before page shortcuts existed, and a page shortcut saved while another row's page was hidden (Dictate's, while dictation was off), met when that page comes back. A page shortcut whose keys another row on screen has saved stands down, its row names that row, and a clash check names it too; two saved page shortcuts on the same keys both stand down and name each other, rather than one quietly winning. Moving either frees the keys. A hidden page's saved keys hold nothing against a row on screen.
6. **Ctrl or ⌘ with a digit is the page shortcuts'.** The reasoning effort slider kept its plain digits and now leaves modified ones alone; nothing else in the window, the application menus or the terminal used these keys.

## Consequences

- Five more rows and Find a setting entries on the Keyboard page; "thread shortcut" in the code's names now covers the page shortcuts too, which `CONTEXT.md` says under **Page shortcut**.
- Two refusals that said "thread shortcut" now say "this shortcut" or "a shortcut here", since page rows show them too.
- A page shortcut that stands down says so only on its own row. There is no other warning, as there is none when a later dictation change takes a row's keys (ADR-0133).
