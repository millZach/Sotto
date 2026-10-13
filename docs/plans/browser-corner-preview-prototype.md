# Browser corner preview prototype

Status: variant A selected by Zach on 2026-09-21; no production browser integration.

## Accepted direction

- Browser stays in the Tools pane (Zach, 2026-09-20).
- A small preview appears in a corner while an agent uses the browser; clicking opens that same page in Tools (Zach, 2026-09-21).
- Variant A (page thumbnail) selected by Zach on 2026-09-21. Preserve its page-first composition, corner placement, and click-to-Tools transition. Zach did not supply a separate rationale for choosing A.
- The prototype uses the bottom-right corner above the composer. Preserve that placement as the selected reference, subject to fitting the actual app layout.

## Question and concepts

A small window onto agent browser work; the proving moment is clicking the miniature and continuing with the same page in Tools.

A: page-first postcard, selected.
B: compact horizontal strip, action first with a small page crop.
C: tall inspection window, page above explicit progress.

Three variants on one standalone HTML prototype using ?variant=A/B/C. The populated shell follows the committed Sotto capture at artifacts/tools-sidecar/browser-1280x800-dark.png. Existing Figtree fonts and theme tokens are loaded directly. A standalone replica is used because this checkout has no node_modules and the production renderer requires Electron bridges; it neither changes routing nor invokes providers.

## Acceptance checks

- Desktop app only: inspect 1600x1000, 1280x800, and 820x560; no clipped preview or controls.
- Browser remains in Tools; preview click opens the same simulated URL and state. Closing Tools returns to the corner preview.
- Page thumbnail dominates A; B and C change structure, not color. Existing quiet shell, Figtree and theme roles stay recognizable.
- New preview copy has at most five purposes: thread, current action, open, pause/resume, dismiss. All controls at least 14px; secondary state at least 12px. Thumbnails are page images, not readable controls.
- Light and dark; foreground text 4.5:1; keyboard focus, Enter activation, Escape to close Tools, arrow variant switching outside inputs.
- Subtle preview arrival and progress; reduced motion disables animation. No auto-navigation of the user's selected thread.
- Pause and dismiss differ; dismiss leaves simulated work running. Show running, paused, finished and failure states. No persistence or external network.
- Review actual rendered states and record evidence below. Native Chromium embedding and real provider checks remain outside this prototype.

Run: node scripts/browser-preview-prototype.mjs

## Review

### Reviewed 2026-09-21

- Rendered in installed Chromium. Preview, composer and prototype controls remain within 1600x1000, 1280x800 and 820x560 in both appearances for all three variants (18 geometry checks). Inspected screenshots of A in dark/light at 1280, B and C at 820, and the expanded Tools pane at 1280. The floating preview covers some conversation text at minimum width, but leaves the composer and header controls available; this is a visible tradeoff for the design decision.
- Fixed cropped thumbnail action area and keyboard activation. Enter now opens Tools, Escape closes it, and arrow keys in the message draft do not change variants. The miniature is inert and excluded from keyboard navigation.
- Verified same saved-trail state after opening Tools; pause disables advancement; dismiss does not pause; finished and failed results are distinct. Reduced-motion emulation removes animation.
- Preview text contrast: primary 12.88:1 dark / 14.69:1 light; secondary 6.25:1 dark / 6.27:1 light against the actual preview background.
- Preview copy purposes: thread owner, current action/open target, dismiss, pause/resume (four); check count is essential progress feedback. Page text belongs to a scaled preview image and is not an interactive text/control surface. Prototype controls and surrounding existing-shell content are outside the changed component's copy budget.
- Compared with the existing Sotto capture: Figtree and its theme palette retained; conversation remains the main surface, page dominates A, action dominates B, and C allocates more height to the page. No new decorative text inside the preview.
- Local review screenshots and JSON live under ignored .claude/tmp/browser-preview/. Normal UI tools failed at process startup with the sandbox ACL helper error; headless Chromium supplied the rendering and interaction review. This is a populated HTML approximation of the shell, not a running Electron integration.
- Run with `node scripts/browser-preview-prototype.mjs`; open http://127.0.0.1:4397/?variant=A (B and C also supported). Port 4318 was occupied, so 4397 is used. The server exposes only the prototype and its font/token assets.
- No production inputs import the HTML, and no provider actions are wired. No production tests or full application gates run; this is a design study captured on the local prototype/browser-corner-preview branch. The selected direction is A; implementation in the real browser remains separate work.

## Implementation reference

Local branch: prototype/browser-corner-preview. Open the saved HTML with ?variant=A using the runner above. Keep B and C on this prototype branch for comparison; they are not implementation options unless the user reopens the decision. No implementation issue or pull request was opened as part of this brainstorming task.
