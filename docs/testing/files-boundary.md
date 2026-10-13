# Files backend boundary

The main-window `sotto.files` bridge reads only a selected Sotto thread's working directory. The renderer supplies a thread ID and a canonical slash-separated relative path; it cannot supply a filesystem root. `src/main/files/binding.ts` uses the shared `resolveThreadWorkingDirectory` policy owned by worktree setup. An explicit native working directory wins over the project fallback, including when that directory is unavailable. Reading Files does not connect a provider, create a thread, send a prompt, change focus or grant management authority.

`src/shared/files.ts` defines the request and response schemas. Root listing returns a workspace identity computed from thread/project binding, configured path, canonical directory and exact filesystem identity. Every subdirectory listing, preview, copy or reveal requires that identity. A mismatch returns `workspace-changed`: clear the old selection and refresh the root, without retrying the old relative path against the new directory.

The service canonicalizes each target and checks containment. Broken or escaping links appear as unavailable entries. File previews compare exact descriptor identity and revision with the resolved target before and after a bounded read; root identity and path resolution are checked again before returning content. Copy and reveal repeat confinement checks before calling Electron's clipboard or file-manager API. The IPC handler accepts only the trusted main window's current top-level frame; the widget has no Files bridge.

Limits are 1,000 enumerated directory entries, four concurrent operations, 512 KiB of UTF-8 text and 8 MiB of raster bytes. PNG, JPEG, GIF and WebP use their byte signatures, with a 16,384-pixel maximum dimension and 40-million-pixel maximum area. Other supported text, including HTML and SVG source, is returned as inert text; Markdown is identified by extension for the existing safe renderer. No file URL or executable HTML preview crosses this boundary. The UI must handle image decode failures, keep safe Markdown/link handling, and avoid interpreting text as HTML. A valid raster header does not guarantee a complete decodable image.

Directory truncation is explicit; this slice does not paginate, recurse automatically, edit files or install watchers. Filesystem identity/revision checks detect ordinary concurrent changes and the tested replacement races. They do not provide an OS filesystem sandbox against a hostile local process repeatedly exchanging and restoring ancestor paths between checks. Hard links already present inside a working directory are ordinary in-directory files. Reveal is a path-based OS handoff, not an atomic descriptor-based action.

Run the focused checks after integrating the worktrees resolver and schema fields:

```sh
npx vitest run tests/unit/main/files.test.ts tests/unit/main/filesIpc.test.ts tests/unit/main/filesBinding.test.ts tests/unit/main/fileImages.test.ts tests/unit/preload/files.test.ts --maxWorkers=2
```

Tests use actual temporary files and Windows junctions (directory symlinks elsewhere), including escape attempts, absent/replaced roots, explicit cwd binding, binary and oversized previews, genuine raster fixtures, IPC sender/frame rejection and preload validation. Parent integration must additionally exercise the real Electron Files panel, focus/pin behavior and native worktree cwd while preserving dictation and drafts.

The inspected T3 reference is commit `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`'s `WorkspacePaths.ts`, `WorkspaceFileSystem.ts` and `FileBrowserPanel.tsx`. Its filesystem reader also accepts absolute host paths; Sotto's explicit task boundary restricts all Files operations to the thread's working directory.

API sources checked September 12, 2026: Node's [directory iteration](https://nodejs.org/api/fs.html#fspromisesopendirpath-options), [descriptor reads](https://nodejs.org/api/fs.html#filehandlereadbuffer-offset-length-position), [descriptor stat](https://nodejs.org/api/fs.html#filehandlestatoptions) and [realpath](https://nodejs.org/api/fs.html#fspromisesrealpathpath-options); Electron's [file-manager reveal](https://www.electronjs.org/docs/latest/api/shell#shellshowiteminfolderfullpath) and [clipboard text](https://www.electronjs.org/docs/latest/api/clipboard#clipboardwritetexttext-type).
