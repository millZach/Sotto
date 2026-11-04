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
