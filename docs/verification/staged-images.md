# A screenshot is staged once and its draft carries a handle (#320)

Checked on September 26, 2026, on Windows, in the built app driven by `tests/e2e/staged-images.spec.ts` (`npm run build`, then `npx playwright test tests/e2e/staged-images.spec.ts`: 1 passed). The provider is the e2e fixture host. The captures cited here are in `artifacts/staged-images/`. Current runs put every capture in ignored `artifacts/e2e-runs/staged-images-run/` by default, or `artifacts/staged-images-run/` with `SOTTO_E2E_EVIDENCE=publish`. See [E2e evidence](../ci.md#e2e-evidence) for the root override. The decision is [ADR-0031](../adr/0031-images-are-staged-once-and-carried-by-handle.md).

The chip looks as it did. What changed is where its picture comes from and what the draft holds, so this note is mostly about what is not there any more.

## Attaching

- Pasting `build/icon.png` into the Workshop thread's prompt showed its chip with a thumbnail, named Staged.png. The thumbnail is the window's own drawing: an `<img>` whose natural size is at most 256 pixels on the long side, whose source contains none of the image's base64.
- Main's state named the image by a handle with its name, type, size and digest. Nothing in the state, and nothing in `agents.json`, contained the image's base64. The profile's `attachments/` folder held one file named by the digest, beside `index.json`.
- `attached-820-dark.png` and `attached-820-light.png`: dark and light at the 820x560 minimum, with reduced motion on. At 1600x1000, 1280x800 and 820x560, in dark and light, the chip and the send button sat inside the window.

## Coming back

- A reload of the window forgot its thumbnails. The chip read the staged image back from main and drew it again, still at most 256 pixels.
- A full restart of Sotto on the same profile kept the draft and its image, because the file was written before the draft named it. `after-restart.png`, light at the size the window reopened at.
- Sending the restored draft put the image in the transcript as the message's preview, and emptied the composer.

## Also run

- After the review fixes (turning history off keeps an image staged for an unsaved draft; an oversize image read over the socket is named as a preview), the spec passed again alone. Run beside `screenshot-paste.spec.ts`, with two Electron apps starting at once, it failed once at a viewport check right after a resize, and passed on its own.
- `tests/e2e/screenshot-paste.spec.ts` and `tests/e2e/composer-short-window.spec.ts` (the one-image layout at 820x560 and in a short split) passed. The keyboard-focus case in the short-window spec failed once while another spec's app was starting and passed on its own.
- `tests/e2e/provider-recovery.spec.ts`: the case that clears a recovered draft passed; it starts from an `agents.json` an older version wrote with the image inline, so the image is staged at start. Its two bind cases time out filling **Thread name** in the New thread dialog, before any image step. They fail the same way on `origin/main` at `bc4110a3` (run in a separate checkout with its own `npm ci` and build), so they are not this change's.
- `tests/e2e/workspace-draft-and-delivery-journeys.spec.ts`: four of its five cases fail, none at an image step. The same four fail on `origin/main` at `bc4110a3`: the image-draft restart case, settlement, the light provider controls and the keyboard case. These are tracked in #340.

## After the second review

The review asked for plainer staging errors, a hash of content on read, a second check of a send's images just before the provider hears them, a draft save that keeps its text without a lost image, and follow-ups from an older build that are paused rather than sent without an image. After those, on a fresh build:

- `tests/e2e/staged-images.spec.ts`, `tests/e2e/screenshot-paste.spec.ts` and `tests/e2e/agent-browser.spec.ts` (browser feedback's Add to draft now stages the capture) passed, twice each in one run.
- `tests/e2e/screenshot-paste.spec.ts` failed once when it ran last in a batch of six specs: the queued screenshot had already been sent when the test read the queue. It passed alone three times.
- `tests/e2e/composer-short-window.spec.ts`: the one-image layout case passed. The keyboard-focus case fails at the same step (**Write here** never becomes enabled) on `origin/main` at `bc4110a3`, so it is not this change's.

## After merging screenshot resizing (#349)

The composer and browser feedback now scale a screenshot to the screenshot bound before they stage it, and the handle carries its sizes. On a fresh build, run alone on an idle machine: `tests/e2e/screenshot-resize.spec.ts` (which now reads each staged image back from main to decode its size), `tests/e2e/staged-images.spec.ts`, `tests/e2e/screenshot-paste.spec.ts` and `tests/e2e/agent-browser.spec.ts`, 5 passed. Run beside the unit suite, `agent-browser.spec.ts` lost window focus at its hidden-capture check and `screenshot-paste.spec.ts` read the queue after its screenshot had been sent; both passed again alone.
