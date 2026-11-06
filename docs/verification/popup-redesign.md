# Popup redesign

2026-11-05. Drake's picks from `docs/prototypes/popup-redesign-prototype.html`: two targets, bubble prompts. ADR-0181's November 5 amendment records them.

The running app was not launched. Evidence here is the real renderer bundle (`npm run build`) in a headless browser with a stubbed `window.sottoPopup`, plus unit tests. So the window itself, a real provider, the Mac's panel and a real drag from Finder are unproven: see **Still needs the running app**.

## Before and after

| | |
| --- | --- |
| Before, Watcher | `artifacts/popup-redesign/before-watcher-dark.png` |
| Watcher, dark | `artifacts/popup-redesign/watcher-dark.png` |
| Watcher, light, reduced motion | `artifacts/popup-redesign/watcher-light.png` |
| The thread after a switch, with a sent photo | `artifacts/popup-redesign/thread-dark.png` |
| A photo in the prompt | `artifacts/popup-redesign/photo-dark.png` |
| The list of threads | `artifacts/popup-redesign/list-dark.png` |
| New thread, the card at its smallest | `artifacts/popup-redesign/new-thread-dark.png` |
| A running turn | `artifacts/popup-redesign/running-dark.png` |

## What was measured

- **A switch no longer resizes the window.** The heights the card asked main for on one switch, from a tall Watcher to the thread: before, 640, then 95, then 363. After, 493 and 493. A unit test holds that no height asked for during a switch is below the one before it, and that a switch reads no history.
- **Words typed survive a switch.** Unit test, by press and by Command+1 and Command+2.
- **Photos.** A file through the picker reached `stageAttachment` with its name and type in the stubbed bridge, and its chip drew. The send carries the handle on `manual-send`; a refusal puts the words and the photo back with the reason. Main admits the popup on the three attachment channels and still parses each request (`popupAgentIpc.test.ts`).
- **A late refusal loses nothing.** A refusal that lands after the user wrote and attached something new puts the refused words and image back ahead of the new ones. Unit test.
- **Copy image.** In the real bundle, Copy image on a sent picture reached the stubbed `copyImage` with a PNG data URL; main admits the popup on `OUTPUT_COPY_IMAGE` and checks the PNG signature as it does for the main window.
- **Contrast on the card.** Dark: reply 12.41, prompt 17.84, placeholder and time 6.36, unpressed target and icons 8.65. Light: 9.75, 14.69, 4.77 and 6.27. Light was measured on the built-in light theme.
- **Reduced motion.** The transcript's fade is `none` under the media query; the owl and the working dot follow the same rules.
- **Width.** A very long thread title cuts off with an ellipsis and the tools row does not overflow.

## Checks

`npm run typecheck` and `npm run lint` pass. Each file below passed in its own run, with `NODE_OPTIONS=--no-experimental-webstorage npx vitest run <file> --maxWorkers=1`: `tests/unit/renderer/popup/popupApp.test.tsx`, `tests/unit/renderer/popup/popupLogic.test.ts`, `tests/unit/main/popup/popupAgentIpc.test.ts`, `tests/unit/renderer/themeTokens.test.ts`, `tests/unit/renderer/scaleTokens.test.ts`, `tests/unit/shared/interfaceCatalogs.test.ts`.

The full suite, Playwright and the design captures run in CI, not on this Mac.

## Still needs the running app

- Press the shortcut, flip between Watcher and a thread, and judge the window: it should hold still. A first flip to something taller than anything shown so far still grows it once, and a short thread after a long Watcher has empty room above it.
- Paste a screenshot, drop a file from Finder, and pick one with the paperclip. Dropping is the likeliest to differ: a drag region takes no drop, so a drop works on the words and the prompt and may miss on the card's bare edges.
- Send a photo to a real thread and to Watcher, and see the sent picture draw. Open it: the viewer is untested inside a window this small.
- That Command+1, 2, K and N reach the popup on a Mac, and Ctrl on Windows and Linux.
- Flip with a turn streaming in the other target.

## Known and left

- Tab reaches the photos in the prompt after Send, because `ScreenshotInput` draws them after its children and CSS places them above. Fixing it means changing that component's order for the main window too, so it stayed out of this change.
- **A photo stays on the computer it was staged on.** Attach one on a thread on a remote host, switch to a target on another computer, and the send fails with the attachment store's words. The same goes for a photo attached with no thread and sent to a new thread in a remote project. Found in review, not fixed. Only reachable with remote hosts.
- **A photo held past an hour can go.** Photos in the popup belong to no draft, so the attachment sweep may delete their bytes after `UNOWNED_ATTACHMENT_GRACE_MS`, one hour, while the chip still draws from its thumbnail. Sending then fails with the same words. Reachable by attaching, hiding the card and coming back more than an hour later.
- Images in a question card's answer stay with the main window: the popup offers no image input on a card.
