# Watcher's room is its conversation: verification

October 27, 2026. `feat/watcher-room-conversation`, on Windows 11 with the built app (`npm run build`) on the Owl track and the Watcher room stand-in. It covers [ADR-0152](../adr/0152-watchers-room-is-its-conversation.md): the tabs, Watched and Visualize gone, Watcher's owl glowing while something waits on the user, and the way off the page right after All threads, as Zach drew it.

## How it was run

```sh
npm run typecheck
npm run lint
npx vitest run tests/unit/renderer/watcher tests/unit/main/watcherRoomDesktop.test.ts tests/unit/main/watcherRoomIpc.test.ts tests/integration/watcherTools.test.ts tests/integration/watcherOwnTools.test.ts tests/integration/watcherPairedHosts.test.ts tests/integration/watcherGate.test.ts
npm run build
npx playwright test tests/e2e/watcher-night-scene.spec.ts tests/e2e/watcher-scene-steady.spec.ts tests/e2e/watcher-column.spec.ts tests/e2e/watcher-recovery.spec.ts tests/e2e/watcher.spec.ts --workers=1
```

Run with one worker: two Electron windows at once could not both be resized, and the window-size steps failed for that reason alone.

## What the captures show

- `watcher-owl-glows-dark-1600x1000.png` and `watcher-owl-glows-light-1600x1000.png`: a watched thread waits on a permission, so Watcher's owl in the left tree is drawn in the accent, glyphs only, with no wash behind it, as the waiting thread owl on the right is. The header holds Watcher, All threads, then the room switch, a hairline, Usage, Settings, Help and the update control.
- `watcher-owl-failed-only-dark-1600x1000.png`: only a failed turn is left in Needs you, and Watcher's owl is back in the ordinary ink, its eyes alone in the accent.
- `header-beside-a-thread-dark-540px-1280x800.png`: Watcher's pane at 540 pixels beside a thread, with Stop all showing. The row keeps to one line, with Stop all at its end.

The night scene journey reads the owls' canvas to tell the accent from the ink, so the glow coming on and going is checked rather than only pictured. The steady-scene journey records every compositor frame while the owl rests and glows again, and finds no blank frame.

## Failures that are not this change

Each of these fails the same way on `origin/main` at `4899f5080`, run in a separate worktree:

- `watcher-night-scene.spec.ts`, the message scrubber's lane: the resting ticks read 1.05 over the scene, against 1.2 expected.
- `watcher-recovery.spec.ts`: the participation stays `participating` instead of `taken-over`.
- `watcher-column.spec.ts`, every word at 4.5:1 in every built-in theme: the composer's placeholder over a white backdrop reads 2.5.
- `watcher.spec.ts`, a reader's place while Watcher works on news: the turn `news-final-3` never draws.
- `watcher.spec.ts`, the header journey's "the name shown" from 451 pixels: the styles hide the name below 580 pixels, on `main` as here.

The room's contrast check measured the lit room tile's 12% tint as if it were solid, so the owl's ink read 1.02 against itself on `main` too. This change fixes the check to read through a faint tint to the surface under it.
