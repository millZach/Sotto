# Point at something verification

October 27, 2026, on `feat/browser-point`, from `feat/browser-pane` at e568aae14. This is ADR-0154's Point at something, behind the `quiet-browser` Owl feature. `tests/e2e/browser-point.spec.ts` launched the built app on the Owl track (`onReleaseTrack('owl')`) over the fake Claude Code provider and a local page with a Sign in and a Save trail button, and ran with `SOTTO_E2E_EVIDENCE=publish`. The user opened the page from the pane's address field. Captures are the window's own pixels (`desktopCapturer` by window title), so the native page main draws, and Chromium's overlay on it, are in them. The window's content was 1280x800 or 820x560. Every capture below was looked at. The measured boxes and the draft's text are in `artifacts/browser-point/verification.json`.

Playwright's mouse reaches Sotto's own window, never the native page main draws over it. The spec moves and clicks on the page with `webContents.sendInputEvent`, which is real input through Chromium: the inspect overlay reads it as it reads the user's mouse, and the hover name, the pick and the picture below all came through main's own overlay path, not a scripted event.

## What the captures show

1. **Pointing** (`hover-1280x800-dark.png`, `hover-1280x800-light.png`): Point at something is pressed, between the address and Screenshot to message, in the accent surface. A line over the page reads "button · Sign in · Click something on the page to point at it · Esc to stop": the name came from Chromium's `Overlay.nodeHighlightRequested` as the pointer reached Sign in. The button is tinted by Chromium's overlay in the theme's accent. The tint is light: Chromium fills an element's boxes and draws no outline, so on a dark button it reads as a lighter green rather than a ring (ADR-0154 amendment).
2. **The comment** (`comment-1280x800-dark.png`, `comment-1280x800-light.png`): a click on Sign in took a picture of the page and put it in the page's place, at the same position, with a 2px accent outline round Sign in, a "button · Sign in" chip under it and the comment beside it: "What should the agent know about this?", Cancel with its Esc key, and Add to message. The field had focus. Main drew no native view while it was open. The outline's centre was within 12 pixels of the button's centre on the page.
3. **The comment at the minimum** (`comment-820x560-dark.png`, `comment-820x560-light.png`): the window shrank with the comment open. The picture scaled down to fit the page's place, and the outline, chip and comment followed it. The comment stayed inside the page's place.
4. **Added** (`added-1280x800-dark.png`, `added-1280x800-light.png`, `added-820x560-dark.png`, `added-820x560-light.png`): a second round pointed at Save trail with the comment "This should say Save, to match the header." Add to message put a picture named "button · Save trail" in the composer, and the draft's text has the page, the screenshot size, "Selected element: button (button) - Save trail", "Selector: #save", where it is outlined, the button's words and the comment. Point ended and focus went back to its button. Nothing was sent. The page's own Save trail handler never ran: the click went to the overlay, not the page.

Between the rounds, Escape in the comment closed it and went back to pointing on the live page with focus on Point at something, and Escape again ended pointing.

The unit tests cover the rest: in `tests/unit/main/browserTools.test.ts`, the overlay going on in the accent for a shown page without sharing or a grant and off again, a page nobody shows doing nothing, the hover name, the pick's description, box and picture, one pick per turn, and navigating, hiding and Escape in the page each ending it; in `tests/unit/renderer/tools/browserPane.test.tsx`, the button's place and state, the line, the comment and Add to message, Escape twice, main ending it, and stable keeping Comment on page; in `tests/unit/renderer/tools/browserReview.test.tsx`, the picture's name and the outline line in the draft.

## Not checked here

- The outline drawn into the picture the agent receives. The renderer draws it on a canvas with the accent; the composer's thumbnail is too small to show it, and no capture opened the full picture.
- A screen reader's reading of the line and the comment.
- Reduced motion: nothing in Point at something moves, so there was nothing to turn off.
- macOS and Linux.
- `npm run design:verify`. Its baselines do not include Tools > Browser on either track.
