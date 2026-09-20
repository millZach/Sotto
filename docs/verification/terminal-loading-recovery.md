# Terminal loading recovery

PR #158, Windows, September 20, 2026. Applies to the Tools panel terminal and Terminal mode.

## Failure and recovery

The original terminal import swallowed a rejected chunk load. A running terminal remained blank with `aria-busy=true`; unrelated renders subscribed again without exposing any recovery.

The regression in `tests/unit/renderer/tools/terminalSurface.test.tsx` failed against that implementation. Both consumers now report a failed view and remove the busy state. The loader effect has explicit dependencies and still loads nothing for a closed Tools panel, an empty Terminal mode, or an injected test factory.

A native Electron probe established that Chromium keeps a failed dynamic import in the document's module map: restoring the missing local file and importing the same URL again still failed. Clearing the JavaScript promise would therefore offer a retry that cannot recover. The recovery action is **Reload window**, which creates a fresh document. Sotto blocks renderer navigation, including `location.reload()`, so the action uses authenticated, main-only, no-payload IPC to reload the main window's existing URL. No destination URL comes from the renderer.

Main keeps terminal processes and output alive during that reload. Thread drafts must first have durability evidence for their latest revision, including edits made while the save waits. Bound structured question answers must also be saved; their existing Save action handles failed writes. A pending or failed save keeps the window open. A failed reload command reports the failure and enables another attempt. Reloading never submits an answer or grants permission.

The syntax highlighter still falls back to usable plain code if its chunk fails. Chromium's cached module failure can persist until a document reload; a later code block is not a guaranteed recovery.

## Native verification

`npm run build` followed by `npx playwright test tests/e2e/terminal-loading.spec.ts tests/e2e/terminal-display.spec.ts --workers=1`: **3 passed**.

The new spec cancels the real built terminal chunk through Electron's request interception, starts a real local shell, and checks the failure state. After allowing the chunk, it presses Reload window with Enter and confirms that the same terminal ID is still running, earlier output remains, and a shell variable set before reload is available afterward. The Tools case types a fresh thread draft just before reload and confirms its text returns. No provider, network service, paid request, or microphone is used.

The neighboring display spec confirms truecolor, contiguous block glyphs, resizing, close/reopen, and GPU context-loss fallback. Its committed captures were restored after verification; no existing design baseline changed.

## Appearance and acceptance

Target: Sotto's native desktop window. This is a recovery affordance inside the existing terminal frame; there is no new surface or design direction. The existing `files-problem` row and `files-link` control are the reference. An inline row keeps the recovery beside the affected terminal; a dialog would cover the thread and a toast would disappear before the problem is resolved.

- Both surfaces captured at **1600x1000**, **1280x800**, and **820x560**, in **light and dark**, with **reduced motion on**. The existing Figtree, theme roles, terminal headers, and shell controls remain. Error text wraps at the minimum width; the action remains visible, with no page overflow.
- The error row has **two text elements**: the failure/output-retention sentence and Reload window. Existing terminal identity and working controls remain necessary operating information. No decorative or repeated explanation was added.
- The affected component is static, so it adds no motion to suppress. Keyboard focus reaches Reload window, and Enter performs recovery.
- Measured text contrast on the rendered surfaces is **14.95:1 to 16.29:1**, exceeding **4.5:1**. Measurements are in `artifacts/terminal-loading/tools-contrast.json` and `workspace-contrast.json`.
- Visual inspection covered minimum, intermediate, and large windows. The single recovery row leads; the rest of the terminal stays quiet and its existing controls remain usable. Parent review independently inspected minimum light Tools, minimum dark Terminal mode, large dark Tools, and intermediate light Terminal mode.

Captures: `artifacts/terminal-loading/{tools,workspace}-{1600,1280,820}-{dark,light}.png`, plus `tools-restored.png` and `workspace-restored.png`. These generated artifacts are ignored by Git and ESLint.

## Checks

After the last review safeguards: `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=2`, and `npm run notices:verify` all passed. The full suite reported **303 files passed, 17 skipped; 3940 tests passed, 34 skipped**, in 359.22 seconds. Notices verified 174 components. Targeted tests also cover loader failure, both terminal consumers, draft durability, authenticated IPC, window lifecycle, and rejected reload recovery.

macOS execution was not available in this Windows review. No platform-specific renderer or recovery branch was added.
