# A Settle the user presses holds its row's place and offers Undo

October 30, 2026. The branch `feat/settle-undo-toast` from `main` at 7ba6a922a, closing #1826 (finding 8 of `docs/research/2026-10-29-ui-hillclimb-desktop.md`) with Zach's pick B, recorded in ADR-0165. Checked on forge in the owned nested Omarchy desktop, at 1600x1000 and the 820x560 minimum, in dark and light, and with reduced motion on.

## What changed

- A Settle pressed with the pointer over the thread list leaves the row's place empty, at the row's height, while the pointer stays over the list (the **held gap**). A second click there lands on nothing. The gap folds away once the pointer leaves the list, at once under reduced motion. A Settle from the keyboard holds nothing and moves the focus to the row now in its place.
- Every Settle the user presses (the row's hover Settle, its menu's, the pane's ··· menu's and Ctrl+Shift+E) shows the **settle toast** at the sidebar's foot: "Settled <title>" with **Undo** for six seconds, held while pointed at or focused. Undo is Restore. Ctrl+Z presses it from anywhere but a text field, a terminal or a dialog, and Undo is the Tab stop after the list.
- Where the settle also removed the thread's worktree, the toast says "Settled <title> and removed its worktree. The branch is kept." with no Undo. It waits for the worktree question's answer before it shows, and says "Removing its worktree…" with its time standing still while the on-settle rule's removal runs.
- In Watcher's room, which has no sidebar, a Settle in the pane beside Watcher shows the toast in the window's corner.
- Settings › Keyboard lists Ctrl+Z as **Undo a settle** under **Fixed & elsewhere** and refuses it to every thread shortcut; one saved on it before keeps it.
- Watcher's settles show no toast and hold no gap.

## How it was run

```sh
npm run i18n:extract
npm run build
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/settle-undo.spec.ts
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/thread-list-keyboard.spec.ts tests/e2e/sidebar-folder-counts.spec.ts
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/workspace-projects.spec.ts tests/e2e/settled-folder-new-thread.spec.ts
```

Each run ran in the foreground, one at a time, with `NODE_OPTIONS=--max-old-space-size=3072`, and each removed its own Hyprland root and left the live Omarchy trees unchanged.

| Spec | Result |
| --- | --- |
| `settle-undo.spec.ts` (new) | Passed. On the design-threads fixture at 1600x1000, pressing Grok voice previews' Settle with the mouse settles it; its place is held at its own top and height, and Streaming WAV stall below stays at the same pixel. A second press at the same point, the mouse not moved, settles nothing else: only `grok-previews` is settled. The toast reads "Settled Grok voice previews", its Undo is named "Undo: restore Grok voice previews", says Ctrl+Z in its title and `aria-keyshortcuts`, and does not have the focus. Undo restores the thread at its old top. Settled again, the gap closes once the mouse moves into the pane, the row below moves up into it, and Ctrl+Z from no field restores it. From the keyboard, the row menu's Settle holds no gap, the focus moves to Streaming WAV stall, and Ctrl+Z restores the thread with the focus left there. Ctrl+Shift+E on the thread on screen gets the same toast, and Ctrl+Z takes it back. At 820x560 the gap and the toast are whole and the toast's words do not overflow; collapsed to the rail, the shortcut's toast stands beside the rail's foot inside the window. With reduced motion on, the gap is gone in the frame after the pointer leaves. |
| `thread-list-keyboard.spec.ts` | Passed: one Tab stop, the walk, the row menu with Settle (Ctrl+Shift+E), F6. |
| `sidebar-folder-counts.spec.ts` | Passed, both tests. |
| `workspace-projects.spec.ts` | Five passed. "Project folders hold several threads…" timed out after 30 seconds, and fails the same way on a build of `main` (`origin/main` at the time) in the same desktop. |
| `settled-folder-new-thread.spec.ts` | Failed at hovering Docs on the Settled shelf at 820x560: the row's own icons cover its middle once the pointer is there. It fails the same way on the `main` build. Neither step settles a thread by a row's Settle. |

The contrast of the toast's words and its Undo on the toast, read from the colours the window drew them in, is in `artifacts/settle-undo/contrast.json`: the words 16.84:1 in dark and 14.2:1 in light, and Undo, in the accent's text colour, 10.77:1 in dark and 6.52:1 in light.

Unit tests run with `npx vitest run --maxWorkers=2` on named files: the new `settleUndo.test.tsx` (18 tests: the gap held, a click on it doing nothing, closing on leave, at once under reduced motion, none from the keyboard or a pointer elsewhere, gone when the thread comes back, rows put back by activity with an emptied folder kept in its place, no gap for a settled project; the toast with Undo, focus landing on the restored row, Ctrl+Z and its standing down in a field and for dictation, its six seconds and its hold, the shortcut's toast going when Restore is pressed, the worktree question's two answers, the on-settle rule removing or refused, a refused Undo and one with no answer, a hold that survives a later Settle under a still pointer and lets go when the sidebar goes, a thread shortcut saved on Ctrl+Z keeping it, and the corner placement), `threadShortcuts.test.tsx` under settings (Ctrl+Z listed and refused), the Watcher room's `watcherContextTile`, `watcherRoomPolish`, `watcherAsks`, `watcherFirstMessage` and `watcherPermissionWatch`, with `sidebarSettleWorktree.test.tsx`, `threadWorktreeReclaim.test.tsx`, `threadSidebarFolders.test.tsx`, `threadListKeys.test.tsx`, `threadSidebarPeek.test.tsx`, `threadSidebarRail.test.tsx`, `needsYouQueue.test.tsx`, `threadWorkspace.test.tsx`, `deleteThread.test.tsx`, `pageSidebar.test.tsx`, `threadPaneMenu.test.tsx`, `themeTokens.test.ts`, `designSystem.test.tsx`, `workingThreadsLine.test.tsx` and `interfaceCatalogs.test.ts`.

## What the captures show

All on the design-threads fixture with Visual gate flake on screen, the moment after Grok voice previews' Settle was pressed with the mouse, which has not moved. A Playwright capture does not draw the pointer; it rests on the empty place.

- `held-gap-1600x1000-dark.png`, `-light.png`: workshop counts 2, the empty place between Visual gate flake and Streaming WAV stall, and the toast just above the room switch, "Settled Grok voice previews" and Undo, as Zach's pick drew it: a plain fill with no hairline or stripe at its edge, and Undo as a text button in the accent's text colour (#1926).
- `held-gap-820x560-dark.png`, `-light.png`: the same at the minimum window. The toast stands in the column's own flow, so the list above it is shorter rather than covered; nothing clips.
- `rail-toast-820x560-dark.png`: collapsed to the rail, Ctrl+Shift+E's toast for Visual gate flake beside the rail's foot, over the room's edge.

## Not checked here

- Windows and macOS. The Windows design captures do not change: none of them settles a thread, and the empty toast region takes no room. No baseline was regenerated.
- Cmd+Z on a Mac, where the Edit menu holds Undo: whether the window still hears it outside a text field. Undo's Tab stop is the keyboard's way there either way.
- A screen reader. The toast is a polite `status`, the window's toast region, and the gap is hidden from it.
- Watcher's room's corner toast in the running app; the unit test covers its placement.
