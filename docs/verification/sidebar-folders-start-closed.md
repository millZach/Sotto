# Sidebar folders start closed, and the resize edge loses its grip — 2026-10-03

Two changes to the Threads sidebar, asked for together. The right edge drew a small pill halfway down, which read as a control of its own; now only the resize cursor and the thin accent line on hover, drag and focus mark it. And every launch opened every project folder, the settled ones too, so a long project list pushed the work you wanted below the fold; now every folder starts closed.

## What changed

- `src/renderer/src/agents/threadSidebar.css`: the `.thread-nav__resize::after` grip is gone. The edge keeps `cursor: col-resize` and its `::before` accent line.
- `src/renderer/src/agents/ThreadSidebar.tsx`: the sidebar keeps the folders the user toggled in session storage instead of component state. Every folder, in the open list and in Settled, starts closed. A folder the user opens stays open while the window lives, including across pages that remount the sidebar, and a fresh launch forgets it. If storage refuses a write, the window keeps its own copy. Searching still opens every folder with a match, and a closed folder still shows its working and waiting marks.
- Under the e2e harness (`window.sottoE2E`, present only with `SOTTO_E2E=1`) folders start open, the way the harness already holds the clock still, so the journeys and design captures keep reaching the rows.
- Terminal mode's folder list is unchanged.

## Automated checks

- `tests/unit/renderer/threadSidebarFolders.test.tsx` (new): every folder starts closed, the open thread's included and the settled ones once Settled is opened; a folder opened before a remount is still open after it; a folder opened while `sessionStorage.setItem` throws stays open, and the next accepted write is read back.
- `tests/e2e/sidebar-folders.spec.ts` (new), against the built app: a folder closed in one launch stays closed after going to Dictate and back, and is open again after quitting and launching on the same profile. That second launch is the proof that Electron does not carry session storage across launches; if it did, the last assertion would fail.
- The suites that are about the rows inside folders open them through `openSidebarFolders` in `tests/fixtures/renderer/liveAgentState.tsx`, which builds keys with the sidebar's own `folderKey`.
- Against the built app, `settled-folder-new-thread`, `split-workspace`, `daily-workspace`, `pane-layouts`, `host-identity`, `agents`, `app`, `thread-sidebar-question`, `thread-sidebar-resize` and `sidebar-folders` pass: 34 tests.

## Design baselines

`npm run design:verify` already fails on `origin/main` at this commit: `onboarding-step-2-microphone-ready.png` and, further on, the Threads captures (folder heads sit a few pixels lower than their baselines), Help, Settings and the Files-unavailable pane differ from what `main` renders today. None of that comes from this change.

So only the baselines whose every changed pixel lies in the grip's strip were retaken: 43 images, the Dictate, History, focus, theme, scale and 760-wide Dictate captures (for example `artifacts/design/app-review/baseline/dictate-ready.png`, where the change is a 4 by 36 pixel strip at x 314 to 317). The 32 captures that also carry `main`'s own drift keep their old images and still show the grip; they belong to the next full retake. `node scripts/verify-design-captures.mjs` passes on the result.
