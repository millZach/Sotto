# Copy in the bottom-left corner, and sent images opened large

October 14, 2026. Zach asked for two things on thread messages: the copy control in a message's bottom-left corner, and a way to open an image he sent large or copy it. He picked from the prototype [`docs/prototypes/message-copy-and-image-viewer-prototype.html`](../prototypes/message-copy-and-image-viewer-prototype.html): variant A for the copy control (inside the corner, shown on hover or focus, on every message) and variant C for the viewer (over the thread pane, with a strip of the message's images). Both go straight to stable; neither is an Owl feature. Work is on `feat/message-copy-image-viewer`.

The copy control moved from the header to the end of the message, so it is pinned to the bottom-left corner and Tab reaches it after the message's words. A message that has one keeps room for it under its last line. Its behaviour is unchanged: a press copies Markdown, the menu offers plain text.

A sent screenshot's thumbnail is now a button. A press opens the viewer over the thread's pane, with the sidebar and other panes still in view; a message outside a pane opens it over the window. The image fits the pane without being enlarged. Zoom, pan and fit are the diagram viewer's own, moved into `usePanZoom` so both use one implementation. With several images a strip steps between them, as do Left and Right, zoomed or not. **Copy image** and Ctrl+C (Command+C) put the image on the clipboard; when Ctrl+C is the dictation hotkey, dictation keeps it and the button still copies. The viewer covers only its pane, so it does not mark itself as a modal for the whole window and shortcuts in other panes keep working. Right-click or Shift+F10 on a thumbnail offers **Open image** and **Copy image**. Escape closes the viewer and focus returns to the thumbnail.

Copying an image goes through main, because the window has no clipboard of its own. The window redraws the image as a PNG and sends it on `sotto:output:copy-image`. Main accepts only a PNG data URL with a PNG signature and an image Electron can decode, waits for any dictation still being pasted, then writes it with Electron's clipboard. On Linux it uses `wl-copy --type image/png` first, the same way text goes. A test run never touches the real clipboard. No host, setting or dependency is added.

## Verified on Windows

- `npm run typecheck`, `npm run lint`, `npm run notices:verify` and `npm test -- --maxWorkers=2`.
- `tests/unit/renderer/messageContent.test.tsx`: the viewer opens inside its pane and makes the rest of the pane inert. It steps with the arrow keys and the strip, which leaves out a file with no picture. Tab stays inside the viewer. Escape restores the pane and focuses the thumbnail. Copy image goes through the bridge from the viewer, from Ctrl+C and from the thumbnail menu, and says when it fails. Outside a pane the viewer opens over the window, with no strip for one image.
- `tests/unit/renderer/threadTranscript.test.tsx`: the copy control comes after the message's words and is not in its header.
- `tests/integration/outputIpc.test.ts`, `preloadBridge.test.ts`, `ipcAuthorization.test.ts`: the channel writes a PNG and refuses a mislabelled image, another type, extra fields, a refusing clipboard and a missing one; the widget cannot call it.
- `tests/unit/main/waylandClipboard.test.ts`: the PNG reaches `wl-copy` byte for byte, and a refusal is reported rather than written as text.
- `tests/unit/main/outputService.test.ts`: other clipboard work, such as Copy image, waits until dictation waiting to paste has been pasted.
- `tests/e2e/image-viewer.spec.ts` in real Electron on the `threadActivity` fixture's new images scenario: hover shows the copy control in the corner in dark and light. The viewer's box equals the pane's. The image draws at its own 1600 pixels. Right twice reaches the third image, zoom and fit work, and Copy image writes a 1200x420 image in main. Escape returns focus, and the thumbnail menu copies the first image.
- `tests/e2e/image-viewer-app.spec.ts` on the built app: a screenshot pasted and sent in a thread opens over its pane at 1600x1000, 1280x800 and 820x560, in dark and light. Every control and the hint line are inside the window, the window controls stay clear, and Copy image answers through the real IPC channel.
- `tests/e2e/copy-message.spec.ts` still passes with the control in its new corner, and `tests/e2e/rich-diagrams.spec.ts` still passes on the diagram viewer, whose zoom and pan moved into `usePanZoom`.
- `npm run design:verify`: `threads-populated.png` changed on purpose, because a message now keeps room under its last line for the copy control. Its baseline and manifest hash are updated. Every other Threads capture is unchanged.

## Limits

- The fixture screenshots show the `threadActivity` fixture's sidebar unstyled; it is that way on `main` too. The built-app screenshots show the real sidebar.
- `design:verify` also reports `scale-125-onboarding.png` and `widget-idle-light.png` changed, and `verify-design-captures.mjs` reports a hash mismatch for `onboarding-step-2-look.png`. This change touches neither page, and that mismatch is already on `main` at `e3e7e2c34`. They were not regenerated.
- macOS and Linux were not exercised. The Linux path is covered by the unit test of `wl-copy`, not on Omarchy.
- A narrow pane (under 640 pixels) shows Copy image as its icon alone and drops the type and size, so the name stays readable.

## Evidence

- [Sent message hovered, dark](../../artifacts/image-viewer/message-hover-1280-dark.png)
- [Sent message hovered, light](../../artifacts/image-viewer/message-hover-1280-light.png)
- [Viewer with three images, fixture, dark](../../artifacts/image-viewer/viewer-1280-dark.png)
- [Viewer zoomed, fixture, dark](../../artifacts/image-viewer/viewer-zoomed-1280-dark.png)
- [Thumbnail menu](../../artifacts/image-viewer/thumbnail-menu-1280-dark.png)
- [Built app, 1600x1000, dark](../../artifacts/image-viewer/app-viewer-1600-dark.png)
- [Built app, 1280x800, light](../../artifacts/image-viewer/app-viewer-1280-light.png)
- [Built app, 820x560, dark](../../artifacts/image-viewer/app-viewer-820-dark.png)
