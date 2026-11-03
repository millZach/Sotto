# A shortcut shows a popup that prompts a thread or Watcher

## Status

Accepted November 2, 2026, at Drake's ask: the Sotto half of his combined Agent Popup should be "actually built into Sotto as a feature", with a shortcut and a place in Settings. An **Owl feature** (`popup`, ADR-0072), by his choice. The look is settled: it is a port of Sotto Popup (`~/Developer/sotto-popup`, October 2026), the native macOS prompt box he built and used, which was already drawn in Sotto's palette, Figtree and owl, so no mock-up round was held. **Number provisional until merge** (docs/agents/domain.md).

## Context

Sotto Popup was a separate Swift app that reached Sotto as a phone, over a pairing code and Tailscale (see ADR-0180 for the connection that replaces that). It showed a small floating card over whatever app was in front, took a prompt, and streamed the reply from a Sotto thread or from Watcher. It was macOS only, and every other Sotto user went without.

## Decision

1. **The popup.** A small floating card Sotto shows over any app: a prompt box at the bottom and the conversation growing upward above it as the reply streams in. It is its own frameless, always-on-top window, separate from the main window and the floating widget, on the current Space, and showing it does not bring the main window forward. It remembers its place for the session. Its width is fixed and its height follows the card, growing upward from its bottom edge to at most 60% of the screen, because a transparent window cannot be resized by hand.
2. **The shortcut.** `popupShortcut`, Alt+Shift+Space by default (Option-Shift-Space on a Mac, the chord Sotto Popup used), changed or cleared in Settings → Keyboard with the same recorder as the other shortcuts. A chord the dictation shortcuts already hold is refused there. The shortcut shows the popup, or hides it when it is showing and has the keyboard; a popup left showing behind another app comes forward instead, as Sotto Popup's did. With no shortcut, the tray's **Show popup** opens it.
3. **One target at a time.** A thread, or Watcher while Watcher is on. A switch at the popup's bottom left shows the target and flips it; the last target is kept for next time. On a thread it continues the thread it last used, until **New thread** (or `/new`); the next prompt then starts one in the project of the thread it was on, or else the project chosen in the main window, on the new-thread defaults. It starts no empty thread. On Watcher it is Watcher's one conversation. A prompt sent while the target works joins its queue, as the main window's composer does.
4. **Keys.** Return sends, Shift+Return is a new line, Escape stops a running thread turn and otherwise hides the popup. A `/` at the start offers `/new`, `/stop`, `/open` and `/watcher` or `/thread`; `/open`, and Command+O or Ctrl+O, shows the thread or Watcher's room in the main window.
5. **Questions and permissions.** A card the target waits on shows in the popup and is answered there, by the user's own press, the same as in the main window. Nothing is answered for them. The cards Watcher passes on from the threads it watches stay in its room.
6. **Inside Sotto.** The popup's renderer reaches main only through the preload bridge, like every window, and uses the same thread and Watcher channels the main window does. It needs no pairing, listener or token. It has a renderer role of its own, `popup`, which only the channels that name it admit: the shell and a thread's history, the room for Watcher's current thread, settings, opening a link, and of the thread commands only observing, starting, prompting, stopping and answering a thread. It is sent no broadcast; main pushes it the record and history of the thread it observes. It observes as a client of its own, which the desktop's host router keeps apart from the main window's panes, so showing it changes nothing the window shows or what notifications count as seen.
7. **Look.** Sotto's own: the theme's colours through `--tt-*` tokens, Figtree, the scale's type and radius steps, light and dark, and reduced motion respected. The owl marks the card while a turn runs.

## Notes from the build (November 2, 2026)

- On macOS the window is a panel shown without activating Sotto and then focused, so it takes the keyboard while the app in front stays in front. This is the documented behaviour of a non-activating panel; it was not seen on a Mac before merge.
- A shortcut recorded in Settings is registered before it is saved, so keys another app holds are refused and the old ones keep working; a saved shortcut that cannot be taken (another app took it later, or Reset all) leaves the popup on the tray, and the row says so.
- Recording any shortcut in Settings stands the popup's aside, and a dictation shortcut being changed to the popup's keys takes them: the popup lets go first and then leaves them to dictation, so dictation is never told another app holds them.
- A thread the popup starts is not opened in the main window: its client keeps its own threads (`keepsSelection`), so neither the coordinator nor the router moves the window's selection.
- On Linux the shortcut is registered through Electron, unlike dictation's Hyprland bindings (ADR-0062); whether Omarchy passes it on was not checked, the row says so, and the tray item always opens the popup.
- The owl is the menu bar owl's night moon (ADR-0137), drawn in the theme's colours; its eyes move only while a turn runs.

## Consequences

Every Owl user on Windows, macOS and Linux gets the popup. On stable it shows nothing and registers no shortcut, and the saved shortcut is kept whole. A new global shortcut is a chord taken from every other app while Sotto runs, which is why it can be cleared. Drake's Agent Popup keeps its own shortcut and its Sotto half, now connected without a code (ADR-0180).
