# Screenshots are scaled down to the longest edge a model reads

## Status

Accepted September 26, 2026 (Zach, option 1 on issue #321).

## Context

The composer read a pasted, dropped or chosen screenshot into a base64 data URL at whatever size it came in. A high-DPI capture is megabytes, and that data URL is carried by every draft save, shell broadcast and persisted state while it waits in the composer, and then sent to the provider. Both providers that take screenshots from Sotto scale an image down to a fixed long edge before the model sees it, so the pixels past that edge cost all of that and change nothing the model reads.

Issue #321 offered three choices: scale down to the largest long edge any supported provider reads, scale only when an image would push a send over the size limit, or leave images alone. The two reviews behind it disagreed: one would downscale, the other would not, because the text in a screenshot is small and matters. Both were right about different bounds. A thumbnail loses text; the provider's own bound does not.

What each provider read on September 26, 2026, from its primary sources (links and versions in `docs/perf/2026-09-26-screenshot-resize.md`):

- **Claude Code.** Claude 4.7 and later models read a long edge of up to 2576 px and at most 4784 visual tokens, and downscale a larger image first. Other Claude models read 1568 px.
- **Codex.** Codex scales a data-URL image itself before its request leaves the computer. Sotto sends images with no detail setting, which Codex treats as `high`: at most 2048 px on either side.
- **Grok Build.** Its client reports no image input, so Sotto sends it no screenshots. xAI documents a file size limit and no pixel bound.

## Decision

**The screenshot bound is 2576 pixels on the longer edge, the largest any of those reads.** The composer scales a screenshot past it down to it before the screenshot joins a draft, in its own format (PNG as PNG, JPEG and WebP as themselves), with its aspect ratio kept. Nothing is scaled up. A GIF, an animated PNG or WebP, and any image whose scaled copy would not be smaller in bytes go as the user attached them. A screenshot of Sotto's own browser added as browser feedback is bounded the same way.

The bound is one long edge, not a per-provider size. Codex still scales past 2048 itself, and a squarer image at 2576 px can still be over Claude's token budget; the provider does the rest. That way the composer never removes a pixel any model Sotto sends screenshots to would read.

Each attachment records its original and sent sizes in pixels, and nothing else about the image (since [ADR-0031](0031-images-are-staged-once-and-carried-by-handle.md), on its handle; the scaled copy is what is staged), so the chip can say **Resized from** the size before **to** the sent size, where a keyboard user sees both, and a screen reader reads them as words.

The work happens in the renderer on Chromium's own decoder and an offscreen canvas. It touches no host and adds no dependency. An image whose first bytes name more pixels than Chromium's largest canvas, 16384 x 16384, is never decoded: it would take more than a gigabyte in the renderer, and the file size limit alone does not stop a flat 10 MB PNG naming that many. It goes as the user attached it, as it did before this decision.

Added after the review of #349: the decision on #321 did not include the rule that a scaled copy is used only when it is smaller in bytes, which leaves a flat 3840 x 2160 capture of text and panels at full size. It stays, because the point of the bound is bytes carried and a larger copy defeats it, and the provider scales that image itself. Zach can overrule it on the pull request that records this.

## Consequences

- A 4K capture with a photograph in it carries about half the bytes it did, and a 5K one about a quarter (`docs/perf/2026-09-26-screenshot-resize.md`). A capture of flat panels and text often stays as it was, because its PNG is already small.
- Adding a screenshot past the bound costs a decode and an encode at paste, 60 to 130 ms more than reading it did. A screenshot that fits is not decoded: its size is read from the first bytes of the file.
- A resized copy is drawn on an sRGB canvas, so a Display P3 capture's colours are converted, and a JPEG or WebP is written again at quality 0.92. The model reads the same size and detail, not the same bytes.
- The per-image and total size limits still check the files as the user attached them, so they refuse exactly what they refused before.

## When to revisit

If Sotto starts sending Codex images at `original` detail, or Codex turns on its `unified_image_budget` feature, Codex would read up to 6000 px, and the bound should be raised to match. The same holds for any new provider or model that reads a longer edge than 2576. `SCREENSHOT_MAX_LONG_EDGE` in `src/renderer/src/agents/screenshotResize.ts` is the one place the number lives.
