# Choose the default projects directory in the folder browser

The owner asked on November 1, 2026 to see the file explorer and select the default projects directory that way, instead of typing it. Settings → Threads → Projects has the field for this computer and one for each connected host.

## Decisions

Recorded from the owner's answers on November 1, 2026.

- **Reuse Add project's folder browser** (#371) for every computer, this one and a host such as forge alike, so a host's folders can be browsed too.
- **Picker only.** The field shows the chosen folder and a button opens the browser. There is no typing.
- **Layout B, path and button.** The folder is written out in full under the computer's name, wrapping when it is long, with **Choose…** (or **Change…**) beside it. Layout A, a field-shaped button that showed the end of a long path, stays on the prototype tag.
- **Clear** empties the folder back to none, as an empty text box did.
- **Start in the saved folder**, and in the home folder when none is saved or the saved one can't be listed.
- A drive's root or `/` may be the projects folder, though a project can't be one (from the review).
- **Keep New folder.** The path is saved as it is; the folder is made when a new project first goes in it, by the same recursive `mkdir` that already makes a project's folder under it.
- A computer that is not connected keeps its folder shown and its button disabled, with the sentence that says how to connect it, as before.

## The pick

The prototype `docs/prototypes/projects-folder-picker-prototype.html` on tag `prototype/projects-folder-picker` (serve it with `tokens.css` and `manrope-latin.woff2` from `src/renderer/src` beside it, then `?variant=A|B`) offered **A Field** and **B Path + button**. The owner picked **B**.

## Shape

- `FolderBrowserDialog` takes `startPath` and `purpose: 'projects-directory'`. That purpose never offers **Open project**, says when a new folder is made, and shows **Saving…** while the choice is saved.
- `ProjectsDirectoryRow` in Settings saves through the same `configure` patch as before, with the host's ID for a remote host, so each computer's folder is saved where it was.
