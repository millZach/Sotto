# An interactive visual in its thread: verification

October 6, 2026. Issue #794, on `feat/interactive-visuals`. The decision is ADR-0056; the glossary term is
**Interactive visual**. The tests use ordinary loads only, as Zach decided; ADR-0056 says what that leaves unproved.

## How it was run

`tests/e2e/visual-sandbox.spec.ts` launches the built app on Windows 11 against the end-to-end provider fixture,
with a TCP listener on loopback that counts every connection. It gives the Workshop thread a prompt and the start of
a reply, then calls the visualize tool through the end-to-end channel with `kind: "interactive"` and a page that
draws a small bar chart with its own script, records the messages it is sent, and makes an ordinary `fetch`, an
ordinary `<img>` and two ordinary links aimed at the listener. The spec reads the page's own record from the guest
in main, and records in main what the `sotto-visual` session and its guests do. Every capture below is from that
run, at a display scale of 150 percent.

## What it showed

- The page drew and ran its script. `window.sotto`, `require` and `process` were undefined in it.
- It received the read-all step (step 0 of 2) and the theme, and its style and colour scheme followed light and dark.
- The frame took the page's own 260 pixels; a 2,000-pixel page was held to 640.
- Escape inside the page put focus back on the card. Show source showed the HTML, and Expand opened the page over the
  window while the card's own page stopped. Escape closed it, back on Expand.
- The fetch and the image were refused by the page's policy (`connect-src`, `img-src`). The links left the page where
  it was and opened no window. A fetch made by the session itself failed with `ERR_BLOCKED_BY_CLIENT`, and the page's
  address could not be loaded a second time.
- The listener saw no connection. No request completed but the pages, no frame committed a navigation but each
  guest's one load, and nothing downloaded.

## Captures

- `artifacts/interactive-visual/page-1280x800-dark.png` and `page-1280x800-light.png`: the card with its header
  ("Interactive page", Show source, Copy source, Expand), the page in the theme's colours and Figtree, and the intro
  and numbered steps under it.
- `page-820x560-dark.png` and `page-820x560-light.png`: the minimum window. The card fits, and the page is clipped
  by the transcript above the composer like the rest of the thread.
- `expanded-1280x800-dark.png`: Expand, with focus on Close.
