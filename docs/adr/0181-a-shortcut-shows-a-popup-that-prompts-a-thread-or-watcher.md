# A shortcut shows a popup that prompts a thread or Watcher

## Status

Accepted November 2, 2026, at Drake's ask: the Sotto half of his combined Agent Popup should be "actually built into Sotto as a feature", with a shortcut and a place in Settings. An **Owl feature** (`popup`, ADR-0072), by his choice. The look is settled: it is a port of Sotto Popup (`~/Developer/sotto-popup`, October 2026), the native macOS prompt box he built and used, which was already drawn in Sotto's palette, Figtree and owl, so no mock-up round was held. **Number provisional until merge** (docs/agents/domain.md).

## Context

Sotto Popup was a separate Swift app that reached Sotto as a phone, over a pairing code and Tailscale (see ADR-0180 for the connection that replaces that). It showed a small floating card over whatever app was in front, took a prompt, and streamed the reply from a Sotto thread or from Watcher. It was macOS only, and every other Sotto user went without.

## Decision

1. **The popup.** A small floating card Sotto shows over any app: a prompt box at the bottom and the conversation growing upward above it as the reply streams in. It is its own frameless, always-on-top window, separate from the main window and the floating widget, on the current Space, and showing it does not bring the main window forward. It remembers its size and place for the session.
2. **The shortcut.** `popupShortcut`, Alt+Shift+Space by default (Option-Shift-Space on a Mac, the chord Sotto Popup used), changed or cleared in Settings → Keyboard with the same recorder as the other shortcuts. A chord the dictation shortcuts already hold is refused there. The shortcut shows the popup, or hides it when it is showing. With no shortcut, the tray's **Show popup** opens it.
3. **One target at a time.** A thread, or Watcher while Watcher is on. A switch at the popup's bottom left shows the target and flips it; the last target is kept for next time. On a thread it continues the thread it last used, until **New thread** (or `/new`) starts one in the project the user last chose. On Watcher it is Watcher's one conversation.
4. **Keys.** Return sends, Shift+Return is a new line, Escape stops a running thread turn and otherwise hides the popup. A `/` at the start offers `/new`, `/stop`, `/open` and `/watcher` or `/thread`; `/open`, and Command+O or Ctrl+O, shows the thread or Watcher's room in the main window.
5. **Questions and permissions.** A card the target waits on shows in the popup and is answered there, by the user's own press, the same as in the main window. Nothing is answered for them.
6. **Inside Sotto.** The popup's renderer reaches main only through the preload bridge, like every window, and uses the same thread and Watcher channels the main window does. It needs no pairing, listener or token.
7. **Look.** Sotto's own: the theme's colours through `--tt-*` tokens, Figtree, the scale's type and radius steps, light and dark, and reduced motion respected. The owl marks the card while a turn runs.

## Consequences

Every Owl user on Windows, macOS and Linux gets the popup. On stable it shows nothing and registers no shortcut, and the saved shortcut is kept whole. A new global shortcut is a chord taken from every other app while Sotto runs, which is why it can be cleared. Drake's Agent Popup keeps its own shortcut and its Sotto half, now connected without a code (ADR-0180).
