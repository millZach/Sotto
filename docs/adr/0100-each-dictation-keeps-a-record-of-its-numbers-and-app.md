# Each dictation keeps a record of its numbers and the app it went into

Accepted by Zach on October 21, 2026 (#1292), so the Journal (#1293) can count dictation without depending on its text. It relates to [ADR-0016](0016-sotto-owned-history-on-an-event-store.md) (Keep local history writes no text while it is off), [ADR-0055](0055-a-failed-dictation-is-kept-in-memory-until-tried-again-or-discarded.md) and [ADR-0071](0071-dictation-transcribes-on-this-computer-with-parakeet.md) (dictation audio never reaches disk; both stand), and [ADR-0078](0078-usage-keeps-numeric-history-on-its-own-host.md) (numbers kept apart from transcript history, the same way Usage keeps its own).

It amends what **Keep local history** governs for dictation. Before, it decided whether anything about a dictation was kept. Now it decides only whether the transcript's text is saved; the numbers are kept either way. It also changes one behaviour: transcripts saved before history was turned off used to disappear from History after a restart with it off. They now stay listed.

## The dictation record

For every finished dictation, main keeps a **dictation record** on this computer:

- `id`, the dictation's own id, which its transcript shares;
- `createdAt`, when it finished;
- `durationMs`, how long the user talked;
- `words`, how many words came out, counted the way a reader would (`Intl.Segmenter`'s word-like segments, so a language written without spaces counts too);
- `app`, the **delivered app**, when Sotto could read one.

There is no text and no audio in it. Records live in `dictation-records.jsonl` beside `history.json` in Sotto's data folder, one JSON line each. Saving a dictation appends one line, so it costs the same however many came before; deleting one rewrites the file atomically; Clear history removes it. A line cut short by a crash costs only that dictation's numbers, and the next record starts on a line of its own. Main reads the file once and holds the records in memory; the window asks for them through `listDictationRecords`, newest first, and asks again after each dictation, delete and clear.

A record that cannot be saved does not fail the dictation or its transcript. Main logs `dictation-record-not-saved`, and nothing else.

## The delivered app

The delivered app is the name of the app that had focus when Sotto pasted or copied the dictation. It is read as delivery starts, before the widget hides for a paste, on the paste path and the copy-only path alike, and kept only when the text was pasted or copied.

- **Windows.** The warm paste helper answers a second command, `app`, alongside `paste`: the foreground window's process, named by its file description, then its product name, then its file name ("Microsoft Outlook", "Windows Terminal", "Sotto"). A UWP app's window belongs to Application Frame Host, so the hosted process is named instead. Its type compiles in the helper's one Add-Type, so the helper starts about as fast as before (a median 530 ms against 506 ms over five starts on the development PC); a query takes under a millisecond warm and about 20 ms the first time, inside the paste delay.
- **macOS.** `/usr/bin/lsappinfo front`, then `lsappinfo info -only name` for that application. Launch Services answers without an Automation or Accessibility grant, so there is no new prompt; System Events is never asked, because it would ask for Automation. This path is NOT VERIFIED on a Mac: it has unit tests on parsing what `lsappinfo` is known to print, but it has not run on one. If it reads nothing there, a Mac's dictations simply have no app until it is fixed.
- **Linux on Hyprland.** The class from the same `hyprctl activewindow -j` the paste adapter runs, made readable where that is cheap: the last part of a reverse-DNS class (`org.gnome.Nautilus` reads Nautilus), and a lowercase class with its first letter raised (`firefox` reads Firefox). It changes nothing on Windows or macOS.

When the name cannot be read there is no app; nothing fails. Main logs `delivered-app-unreadable` when a reader throws, and never the name.

The window never names an app. Main holds the app it read for that dictation's id until the window reports the finished dictation, then adds it to the record and, while history is on, to the transcript. The window's report is refused if it carries an app.

### Why the app name is safe to keep

It is a display name and nothing more: never a window title, a document name, a URL or anything read from the app. It is read without any permission Sotto does not already hold, through no new host, and it is kept on this computer only. Nothing is sent anywhere, and it is never logged.

## History on, off, retention, delete and clear

- **History on.** The transcript is saved as before and also carries the app name. The record is kept.
- **History off.** No text is written. The record is kept, so stats keep working. Main reads the saved transcripts without recovering or rewriting them, so a corrupt `history.json` stays as it is.
- **Transcripts saved before history was turned off** stay listed, and can be copied, deleted and cleared while it is off, including after a restart.
- **Retention** (25, 100, 500 or Unlimited) trims transcripts. Records are never trimmed.
- **Delete** removes everything about that dictation: its transcript and its record.
- **Clear history** removes every transcript and every record, with their backups and temporary files.

## Filling the records on the first start

On a start with no records file, main writes a record for every saved transcript: its words counted from the text, its app only if the transcript carries one, which none from before this change do. This runs once. When the file is there, even empty, it is never filled from transcripts again, and after Clear history there are none to fill it from. A fresh install with no transcripts writes no file until its first dictation.
