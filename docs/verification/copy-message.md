# Copy a message or a reply

September 20, 2026. Implements issue millZach/Sotto#128 from Zach's selection of prototype variant C (floating corner), archived on `prototype/copy-message-corner` at `7a9385c4`. Work is on `feat/copy-message`, based on `main` at `a1466a79` (Release 0.1.10).

Each finished message and reply carries a quiet copy mark pinned to its top-right corner, revealed while the message is hovered or holds focus. A press copies the message's source Markdown through the main-owned clipboard path. Right-click, Shift+F10 or the ContextMenu key opens a two-item menu: Copy as Markdown, Copy as plain text. Plain text is a deterministic walk of the rendered message — code-bar controls and feedback are dropped, table cells separate with tabs, code keeps its written form. A reply still being written has no control; each code block keeps its own copy button.

## Verified on Windows

- `npm run typecheck`, `npm run lint`: clean.
- Focused unit runs: `richActions.test.tsx` covers the plain-text walk over a real `MessageContent` render (heading, list, three-column table, fenced code — no Markdown marks survive, cells are tab-separated). `threadTranscript.test.tsx` covers placement (two controls across a user message and a finished reply, none on the reply being written), the Markdown press and its 1.6-second "Copied", the Shift+F10 menu and plain-text item, Escape refocus, and "Copy failed" on a refused clipboard.
- `npm run build`, then `tests/e2e/copy-message.spec.ts` in real Electron on the `threadActivity` fixture (Copies recorded in main): rest opacity 0, hover reveals, leaving hides, focus reveals with a visible ring, Enter copies the reply's source Markdown verbatim, the menu's plain-text copy drops the Markdown marks, Escape returns focus, and 820x560 shows no horizontal overflow.
- `npm run design:verify`: the Threads-page captures pass in dark and light — the control is invisible at rest, so no baseline moved.

## Existing failures and limits

- `tests/e2e/thread-activity.spec.ts` fails at a stale assertion predating this change: it expects the rich-message font size 16px, while `f98b5e7c` set it to 15px on `main`. Unrelated to this feature.
- `design:verify` reports `help.png` changed materially against its baseline (2,226 pixels over the 549 limit). The Help page renders nothing under `.thread-message`; this diff touches only the transcript. Observed as baseline drift, not regenerated.
- macOS was not exercised; the change is CSS and a DOM walk with no platform surface.

## Evidence

- [Reply hovered, dark](../../artifacts/copy-message/reply-hover-1280-dark.png)
- [Reply hovered, light](../../artifacts/copy-message/reply-hover-1280-light.png)
- [Copy menu open](../../artifacts/copy-message/menu-1280-dark.png)
- [Focused at the minimum window](../../artifacts/copy-message/reply-focus-820-dark.png)
