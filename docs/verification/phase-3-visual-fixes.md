# Phase 3 visual fixes: minimized theme editor over the browser, and a failed personal message

Fixes findings 1 and 3 of `phase3-visual-critic-result.md`. Finding 2 (the minimized bar's resting spot over Send) belongs to the theme owner.

Target: the Windows Electron desktop window, with pointer and keyboard. Phone layouts are out of scope for a desktop app. Reviewed at 820x560 and 1280, light and dark.

## Tastify acceptance checks

Scoped edit inside the established Crossing identity. There is no new concept, typeface, palette or motion. The reference is the current app's own delivery row and activity disclosures.

1. **Browser composition.** A minimized theme editor whose box does not intersect `.browser-viewport` leaves the live native page showing (one host `WebContentsView`, bounds equal to the viewport). Verify with a composed `desktopCapturer` window capture, not `page.screenshot`, which omits native views.
2. **No native paint over the editor.** When the editor is expanded, or the minimized bar is dragged over the viewport, the page steps aside (zero host views) and the editor is fully visible in the composed capture. The page state and identity are unchanged when it returns: same URL, same `webContents` id, a typed input value kept, and no new window or external launch.
3. **Modal behavior unchanged.** Menus and other dialogs still send the page aside, as before, in unit tests.
4. **Failed message hierarchy.** The user's own message is the dominant text in a "Not sent" card. The reason is one short human sentence ("Codex did not take this message."). **Edit in composer** sits beside the reason and stays in the viewport at 820x560 in light and dark, even with a long raw error.
5. **Diagnostic kept.** The raw error is collapsed behind one **Details** disclosure. It is reachable by keyboard (Tab to the summary, Enter to open), and the text is selectable and wraps inside the card with no sideways overflow. Nothing is discarded.
6. **Copy.** Each element carries one line: status label, message, reason, action, disclosure label. The reason does not repeat the "Not sent" label.
7. **Type.** No new text below 12px. The diagnostic uses the existing mono code size.
8. **Recovery unchanged.** Opening Details does not send anything, and Edit in composer still appends after a newer draft with its skills, never autosending.

## Results

**Build.** Worktree `out/`, built with `npm run build` from this branch's source. Journeys ran in `tests/e2e/phase-three-visual-fixes.spec.ts` (2 passed) with owned temp profiles, the `success` fixtures and a local HTTP page. No paid or native provider ran.

**Captures.** All are composed `desktopCapturer` window captures at the window's device pixels, in `artifacts/phase-three-visual-fixes/`. Every image named below was opened and inspected. The "before" images are the critic's, in main `artifacts/phase-three-visual-critic/` (`editor-minimized-browser-820x560-dark.png`, `editor-minimized-browser-1280-dark.png`) and `artifacts/phase-three-ui-recovery/chat-not-sent-*.png`.

1. **Browser composition: pass.**
   - `editor-minimized-beside-page-820x560-dark.png` and `-light.png`, plus `-1280-dark.png` and `-1280-light.png`: the bar sits left of the Tools panel and the live page shows beside it.
   - The journey asserts one host view whose bounds equal the rounded `.browser-viewport` rectangle, whenever the bar's rectangle is clear of it.
   - While the bar was dragged 24px within the clear area, each of 12 samples had 1 view. Six samples taken 100ms apart while still were identical, so nothing re-attached.
2. **No native paint over the editor: pass.**
   - At rest, the bar is at 440,474 360x68, which overlaps the viewport at 820x560 with Tools open. There the page steps aside (`editor-minimized-resting-820x560-dark.png`).
   - Dragged over the page, the page also steps aside (`editor-minimized-over-page-820x560-dark.png` and `-light.png`). The bar is whole, and the covered note sits under it.
   - Expanded, the page steps aside (`editor-expanded-820x560-dark.png`).
   - After the moves, resizes between 820x560 and 1280x860, an expand and minimize, and three editor openings, the page is the same: same `webContents` id, same `performance.timeOrigin` (no reload), same URL and same typed note. The window count is unchanged. A patched `shell.openExternal` recorded no calls.
3. **Modal behavior unchanged: pass.**
   - `browserSurface.test.tsx`: a plain `role="dialog"` still hides the page while the bar is clear, and an expanded editor still hides it.
   - The existing `phase-three-ui.spec.ts` link-menu journey passes.
4. **Failed message hierarchy: pass.**
   - `chat-not-sent-820x560-dark.png` and `-light.png`, `chat-not-sent-1280-dark.png`.
   - The card reads: "You", Not sent, the message at body size, then a muted line "Codex did not take this message." with **Edit in composer** on the same row, then ▸ Details.
   - The message, status, reason and action are asserted in the viewport at 820x560 in both modes. The critic's version showed four lines of path above the action, with the message scrolled away.
5. **Diagnostic kept: pass.**
   - By keyboard: Tab from Edit in composer reaches Details, and Enter opens it.
   - The `<pre>` holds the whole diagnostic, verified against the saved `submission.error`. It wraps with `overflow-wrap: anywhere` (card `scrollWidth - clientWidth <= 0`) and its text is selectable.
   - Opening it keeps the summary in place, using the transcript's existing disclosure anchoring, so Edit in composer stays in view (`chat-not-sent-details-820x560-dark.png` and `-light.png`).
6. **Copy: pass.**
   - The card has six text elements: "You", "Not sent", the message, the reason, the action and "Details".
   - The reason names who refused it, where the status says only the state, so it is not a repeat.
   - The earlier raw text was not a sentence, so it is moved under Details rather than kept as a companion line.
7. **Type: pass.** The reason stays at the delivery row's 13px, the summary is 13px, and the diagnostic is 12px mono.
8. **Recovery unchanged: pass.**
   - `chat-not-sent-recovered-820x560-dark.png`: with Details open, Shift+Tab then Enter on Edit in composer puts the message in the composer after the newer draft ("Also check the weather", a blank line, then "Book the ferry with $brainstorm for Saturday").
   - The `brainstorm` skill ref is kept, there is still one submission, and the composer has focus.
   - "It is in the composer." replaces the button, and the diagnostic stays under Details.
   - The existing `phase-three-ui-recovery.spec.ts` failed-send journey passes.

## Limits

- The bar's default resting spot is the theme owner's (finding 2). With Tools open, today's spot overlaps the page at 820x560 (measured). By the critic's numbers it also overlaps at 1280x860, so the page correctly stays aside until the bar is moved. The journey checks the rule wherever the bar rests, not fixed coordinates.
- An expanded editor that happens to be clear of the page still hides it. These semantics were kept narrow on purpose.
- While a minimized bar is the only overlay, its rectangle is read once per animation frame. Only a mounted browser page does this, and it costs one selector query and two rectangles. A fast drag onto the page can show about one frame of overlap before main hides the view, the same latency dialogs already had.
- The expanded editor can extend past the window bottom after being dragged low while minimized (`editor-expanded-820x560-dark.png`). Its clamp belongs to the theme owner.
- Project threads render `submission.error` raw in the same way (`src/renderer/src/agents/ThreadTranscript.tsx:71`). That file is outside this worker's ownership.
