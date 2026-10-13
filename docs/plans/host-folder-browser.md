# Add project on any paired computer

The owner asked on September 26, 2026 to start a project on Forge from the laptop: Add project asks which computer the project lives on when more than one is paired, then browses that computer's folders, and the project's threads run there and show in every Sotto connected to it. The phone half is another agent's (#225) and out of scope here.

## Decisions

Recorded from the owner's answers on September 26, 2026.

- **This computer counts.** The computer step lists this computer and every paired host, and is skipped when there is only one.
- **Start in the home folder**, and allow going above it, up to `/` or the drives, so a project on `D:\` stays reachable.
- **New folder** is offered. It is a name until Use this folder, when `create-project` makes it.
- **No computer is chosen for the user**, and the last one is not remembered.
- **Folders only**; files are not listed.
- **This computer offers its own folder dialog** as a button in the browser, **Browse with File Explorer** (Finder on a Mac). It is not offered for a remote host, whose disks it cannot see.
- **Paths stay in the host's format.** The host lists and splits them, and names a folder by its own rules, so a Windows desktop browsing a Linux host translates nothing (the owner's "make sure that format is compatible with Linux"). The window's one join, a new folder's name, uses the separator and the naming rules of the host.

## The pick

The prototype `docs/prototypes/host-folder-browser-prototype.html` on branch `prototype/host-folder-browser` (serve with `node docs/prototypes/host-folder-browser-prototype.mjs`, then `?variant=A|B|C`) offered three layouts: **A Steps**, computers then folders in the New thread palette; **B Places**, a computers rail beside the folder pane; **C Path bar**, computer chips above a typed path. The owner picked **A** on September 26, 2026. B and C stay on the prototype branch.

New thread keeps its host buttons. Its folder source (**Local folder**, or **Folder on forge** for a remote host, which it did not offer before) opens the same browser with the host already chosen.

## Shape

- A host request `host-folders` behind the host feature of the same name (ADR-0025, September 26 amendment; `docs/host-protocol.md`), answered by `listHostFolders` in `src/main/agents/hostFolders.ts` on the desktop's local host and the headless host alike.
- The desktop routes the window's request to the named host (`DesktopHostRouter.hostFolders`), not the host for new work.
- `FolderBrowserDialog` in the renderer; `useAddProject` selects the chosen host, then sends `create-project` or `select-project`.
