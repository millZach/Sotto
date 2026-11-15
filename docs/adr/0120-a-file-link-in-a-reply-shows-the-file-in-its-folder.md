# A file link in a reply shows the file in its folder

## Status

Accepted October 23, 2026. Drake Morey asked for links in a thread's reply that name a file, rather than a web page, to show that file. Shipped as an Owl feature first ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)), id `reveal-linked-files`. Follows the Files rules in [ADR-0025](0025-headless-host-and-client-identity.md) for paths and paired hosts. **Number provisional until merge** (docs/agents/domain.md).

## Context

Agents often answer with a link to a file they wrote or read: an absolute path, a `~/` path, a path inside the thread's folder or a `file://` link. Until now a reply showed such a link as inert text, since only web addresses open. The user had to find the file by hand.

## Decision

**Show, never open.** Pressing a file link, or pressing Enter on it, shows the file selected in its folder in File Explorer on Windows, Finder on a Mac or the file manager on Linux. Main does this with Electron's `shell.showItemInFolder`, as Files' **Show in folder** does. Nothing runs or opens the file itself, so a link cannot start a program, whatever it points at.

**One checked channel.** The window sends `sotto:files:reveal-link` with the thread's ID and the path as the reply wrote it. A zod schema refuses control characters, network shares and device paths (`\\host`, `//host`, `\\?\`) and drive-relative paths (`C:file`). Main answers only the main window and only for a live thread on this computer. A path relative to the thread's folder must stay inside it after links are followed, as in Files. An absolute or `~/` path may name any file or folder on this computer, since showing it opens nothing. When the path as written is not found, main tries it once without a trailing location such as `:12`, `#L12` or `#page=2`. The window learns only whether the file was shown, never where the path led.

**Not on a paired host.** A path in a paired host's thread names that host's file, so the link says it can't be shown here.

**Owl gate.** While the feature is off, which is stable until Zach sends it, a file link stays inert text as before and main refuses the channel with a message, read once at start.

## Consequences

A reply can point at a file the user can then open themselves. A link to a file outside the thread's folder reveals where it lives, which the reply already said. Sending it to stable is flipping its `sentToStable`.

## November 3 amendment: a Markdown link opens in the side panel

Zach asked for it on November 3, 2026, picked A of `docs/prototypes/markdown-side-panel-prototype.html` and approved this text. Owl feature `markdown-side-panel`; while it is off, a Markdown link shows in its folder as above and main refuses the read with a message. This changes one fact above: a press on a Markdown link reads the file. The text goes only to the window and never to a model.

**Show, never run.** A press on a link to a `.md`, `.markdown` or `.mdown` file, or Enter on it, opens it read only in the side panel: Tools > Files on the Threads page, the beside pane's place in Watcher's room. It is drawn by the transcript's safe Markdown renderer, so a link in it runs nothing and a picture in it stays unloaded. Every other file still shows in its folder.

**Which files.** The window sends `sotto:files:preview-link` with the thread's ID and the path as the reply wrote it, under the same schema and sender check as `sotto:files:reveal-link`. A path relative to the thread's folder must stay inside it after links are followed. An absolute or `~/` path may name any Markdown file on the machine the thread runs on. The path as written and the file it really is must both end as Markdown does, so `notes.md` pointing at a key is refused. Text is read up to 512 KB and must be UTF-8. The window gets the file's text, its size and the link's own name, never where the path led.

**Paired hosts.** "Not on a paired host" still holds for showing a file in its folder, and no longer for Markdown. The host reads the file under the same rules and answers `thread-file-link`, behind the `thread-file-links` feature, which it offers desktops only and only where its own Owl answer is on. A full path in Watcher's reply that lies inside another thread's folder is read from that thread's machine, the deepest folder first, since Watcher's workers may be elsewhere. Any other path in Watcher's reply is read on Watcher's own machine.

**The folder view.** The panel keeps Show in File Explorer for a file on this computer. Right-clicking the link, Shift+F10 or the menu key offers Open in side panel, Show in File Explorer and Copy path. On a paired host the first of those is left out of the panel, and the menu's says why when pressed.

**Models link what they make.** Claude Code, Codex and Grok Build threads are told, beside what they are told about asking the user, to link any Markdown file they write or name by its full path. Watcher is told the same in its prompt, with a worker's path as the worker gave it. The other providers take no instructions from Sotto, so inline code that names a Markdown file by a relative path, such as `docs/plan.md`, is a link too, and a model that forgets still leaves one.

**In Watcher's room** the file takes the beside pane's place, with the same divider. A thread already beside Watcher waits behind it with its draft and reading position, and Back to its title, the close button or Escape brings it back. Opening a thread puts the file away.

**Not here.** The iPhone and the Android client have no file links. A link inside the open file does not open another file.

## November 9 amendment: a link opens however the agent wrote the path

Zach reported on November 9, 2026 that a link to a Markdown file that was there opened "This file is not on the computer this thread runs on". Codex on Windows had written `[project instructions](</D:/Seduce Jensen/AGENTS.md>)`, and Windows reads `/D:/...` as a folder on the current drive. A survey of ten days of Claude Code and Codex replies on the laptop and forge found the forms agents write: `/D:/...`, `D:/...` and `D:\...`, with or without angle brackets, spaces and `%20`, dot folders, `file:///`, `~/`, `./` and `../`, lines (`:12`, `#L12`), headings (`#reading-a-failure`) and folders outside the thread's. Every one of them opens now. This follows the decision above rather than changing it; what it settles:

- **Drive first.** A path written `/D:/...`, as a `file:` URL's path or by Codex, is read as `D:/...`. The window does this for every link it draws, so Watcher finds the worker whose folder holds it. Main does it too, after trying the path as written, for a request that reaches it unchanged.
- **A heading is a location.** A trailing `#fragment` without a folder separator is dropped when the path as written is not found, as `#L12` was.
- **The path as the reply wrote it.** Markdown reads a backslash before punctuation as an escape, so `C:\Users\me\.claude\CLAUDE.md` lost the separator before `.claude` (#2218). A link whose path starts with a drive, `~` or `.` and a backslash keeps the path as written, with a doubled backslash read as one.
- **A path with spaces and no brackets.** `[audit](D:/Watcher Audit/audit.md)` is not a link in Markdown, so it showed as text. Written as a name in brackets and a path that reads as a file (absolute, `~/`, `./`, `../`, `file://`, or relative with a folder and a file name), it is drawn as the link the agent meant. Code, web addresses and any other scheme are left as they are. A relative path that leads outside the thread's folder is still refused, as above.
- **What agents are told.** Threads and Watcher are told to put the path in angle brackets, so a path with spaces stays a link, and threads to use forward slashes, as in `[plan.md](<D:/My Project/plan.md>)`.

## November 12 amendment: a file link opens the file, and a paired host's file shows in Files

Zach asked on November 12, 2026 for a file link to open the file or its place: on this computer in the file's own app, and on a paired host in Tools > Files with an optional download. He picked from `docs/prototypes/linked-files-open-and-remote-prototype.html`: B (a press opens it), 1 (a program is never run), A (Download is an icon), 1 (saves to Downloads) and 1 (a file outside the thread's folder is shown alone). All of it is the `reveal-linked-files` Owl feature, and he holds it in Owl. This reverses "Show, never open" above and ends "Not on a paired host". What stays is the reason for both: a link cannot start a program, and the window never learns where a path on this computer led.

**A press opens.** On this computer a press on a file link, or Enter on it, opens the file in the app the computer has for it, and a folder in the file manager. Main does it with Electron's `shell.openPath`, over `sotto:files:open-link`, under the same schema, sender check and path rules as `sotto:files:reveal-link`. A Markdown link still opens in the side panel. Right-clicking any file link, Shift+F10 or the menu key offers Open, Show in File Explorer and Copy path, with Open in side panel first for a Markdown file.

**Never a program.** A link never opens a program, an installer, a shortcut or a script, so pressing one cannot run anything. Main decides, in five ways, and any one is enough: the name the link wrote, the name of the file it really is once links are followed, how the file starts (a Windows, Linux or Mac executable, or a script that names its interpreter), on a Mac or Linux whether the file is marked as one anyone may run, and for a folder a Mac's app bundle endings. The mark matters because a Mac hands a runnable file with no ending it knows to Terminal, which runs it; so a document that carries the mark, as every file on some USB drives does, is shown and not opened. `isProgramFileName` in `src/shared/files.ts` holds the endings, one list read on all three systems, since a file made on one is opened on another: among them `.exe`, `.bat`, `.cmd`, `.msi`, `.ps1`, `.vbs`, `.js`, `.lnk`, `.jar`, `.app`, `.command`, `.pkg`, `.desktop`, `.AppImage`, `.sh`, `.py` and `.pyzw`. Such a file is shown in its folder instead, and the reply says "… is a program or script, so it was shown in its folder. Nothing was run." Its link says Show in File Explorer rather than Open, and its menu offers no Open. A file main cannot read is taken for a program. The answer tells the window only whether the file was opened or shown.

**A paired host's file shows in Files.** A press on a file link in a thread on a paired host opens Tools > Files on that thread, with the file selected in the tree and its folders open, or the folder open for a link to a folder. The window asks where the file is over `sotto:files:linked-file`, and main asks the host; the channel answers for a paired host's file only, and refuses one on this computer. The answer names a place only inside the thread's folder, which Files lists anyway, and the file by the link's own name. A Markdown link there still opens in the side panel. The link's menu offers Show in Files, Download and Copy path; nothing on this computer can open or show a host's file, so Open and Show in File Explorer are not offered there.

**Outside the thread's folder, the file alone.** A full path may name a file anywhere on the host, as a Markdown link already could. Files shows that one file alone, a Markdown file included: its name, size, the host, its whole path as the link wrote it, and its preview where Files has one (text and Markdown up to 512 KB, PNG, JPEG, GIF and WebP up to 8 MB). Nothing around it can be browsed, and a link to a folder outside the thread's folder says it cannot be shown. Watcher's room has no Tools, so a worker's file on a paired host is shown alone there too, in the beside pane's place, read on the worker's own machine.

**Download.** A file on a paired host has a Download icon in its head, beside Copy path, in the tree's preview and when shown alone. It saves the file to this computer's Downloads folder under its own name, numbered as a browser numbers a name already taken; a name too long to save is cut before its ending. A line under the head shows how far it is with Stop, then "Saved … to Downloads on this computer" with Show in File Explorer and Open; Open follows the rule above, so a downloaded program is shown and not run. The bytes come in 4 MiB parts into a `.part` file beside the name, which takes the name only when every part has arrived, so a download that stops, fails or meets a file that changed on the host leaves nothing. The name is claimed by creating it, so a file that took it meanwhile is never replaced, and a stop that arrives as late as the rename removes the file again. It is saved under the link's own name. A folder is not downloaded. Main writes the file and hands the window a handle and the saved name, never a path, and the window is never handed the file's bytes.

**The host's side.** The host answers `thread-linked-file` behind the `thread-linked-files` feature, which it offers desktops only and only where its own `reveal-linked-files` answer is on: where a linked file is, its preview, or one part of its bytes. It reads the file and writes nothing. A desktop already runs agents and a terminal on a host it is paired with, so reading a file there by its path gives it nothing new; a phone is offered none of it. A host from before this says, in the version sentence, which side to update.

**Not here.** A file on this computer is not downloaded, and Files does not open one in its app. The iPhone and the Android client still have no file links.
