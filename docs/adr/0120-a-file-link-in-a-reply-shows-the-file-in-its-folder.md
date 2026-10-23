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
