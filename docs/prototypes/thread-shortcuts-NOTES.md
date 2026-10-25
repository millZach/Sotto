# Thread shortcuts — prototype notes

Question: what should editable keyboard shortcuts for threads (New thread, Settle, …) look like in Settings, and how should recording a new chord behave?

Prototype: `thread-shortcuts-prototype.html` (open in a browser; state in memory only). Three variants: A, a group on Settings › Threads; B, its own Settings › Keyboard page; C, a `?` cheat-sheet edited in place.

## Decision (October 24, 2026)

**B chosen** — its own **Settings › Keyboard** page. Refine only this direction; A and C stay switchable in the file for reference. Prototype not approved for production yet: production must reuse the real recorder and chord plumbing (below), not this file's JavaScript.

What B means in production terms:

- New page `settings-keyboard` ("Keyboard") in the rail after Threads, same run — see `SETTINGS_PAGES` in `src/renderer/src/features/settings/settingsPages.ts`; one `settingsIndex` entry per row (`data-setting="shortcut-…"`) so Find a setting lands on the row.
- One settings field, `threadShortcuts: Record<id, chord | null>` in T3 chord spelling (`mod+shift+n`), parsed/matched by `parseChord` / `chordMatches` / `chordClaimed` (`src/renderer/src/agents/branchToolbar.logic.ts`); invalid entries repaired to defaults on load, like the dictation hotkey.
- Recorder and chips reused from Dictation shortcuts: `useChordRecorder`, `DictationShortcuts.tsx`, `ShortcutKey`. Rules: needs ⌘/Ctrl, no modifier-only/Fn chords, conflicts refuse and name the owner, dictation always wins, Esc cancels, ⌫ clears, save on release.
- Every existing chord becomes a default (New thread `mod+shift+n`, Changes `mod+d`, drawer `mod+j`, zoom, branch-bar trio, quote, open-beside); Settle `mod+shift+e`, Restore, Close pane, Next/Previous thread, Next waiting on you, Focus prompt, Stop turn are new. Tooltips and `aria-keyshortcuts` derive from the field (cf. `newThreadChordLabel`).

Decided alongside (October 24, 2026, on recommendation):

- **Zoom pane normalizes to `mod+shift+m`.** Today's `ctrl+shift+m` (`ThreadPanes.tsx`) is the one chord that breaks the mod pattern every other row follows; off Mac nothing changes (mod is Ctrl there), and because the row is now editable, anyone who wants the old keys can record Ctrl+Shift+M back. The one intentional default change in an otherwise defaults-preserving move.
- **Help does not duplicate the list.** Help keeps its dictation mentions in prose and gains one line pointing to Settings › Keyboard. Keyboard's "Fixed & elsewhere" section stays the single gathered reference for fixed keys — two lists would drift.

## Still open

- Rail cost accepted? B makes twelve Settings pages; Threads page keeps no shortcut rows (at most a link row to Keyboard).

## Built (October 24, 2026)

B is implemented with this prototype's production change (ADR-0133): `settings-keyboard` page, `threadShortcuts` field, all shipped chords rewired, seven new shortcuts live. Deviations from this mock-up, each forced by the real code:

- **Stop the running turn defaults to `mod+shift+s`, not `mod+.`** The shared recorder's key table has no punctuation, so `.` could be shown but never re-recorded.
- **Restore defaults to `mod+alt+r`, not `mod+shift+r` (PR review).** Off a Mac `mod+shift+r` is the application menu's Force Reload, which fires before the renderer; the Keyboard page now refuses menu-owned chords and a test pins every default clear of them.
- **Clearing is a Remove (✕) button, not ⌫ while recording** — the dictation recorder's own pattern; the prototype's recorder was its own invention.
- **The "Rooms ⌘1/2/3" fixed row was dropped.** No such shortcut exists in Sotto; the shipped Fixed list names only real keys.
- **Ungated, on stable**, as mocked — recorded in ADR-0133 decision 6 with Find a setting as precedent.
