# An interactive visual in its thread: verification

October 6, 2026. Issue #794, on `feat/interactive-visuals`. The decision is ADR-0060; the glossary term is
**Interactive visual**. The tests use ordinary loads only, as Zach decided; ADR-0060 says what that leaves unproved.

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
- It received step 1 of 2 with that step's name (`bars`) and the theme. Next in the card's walkthrough showed step 2 on the page, Read all showed every step, Step through went back to step 2 and Start over to step 1. Its style and colour scheme followed light and dark.
- The frame took the page's own 260 pixels; a 2,000-pixel page was held to 640.
- An Escape the page dispatched itself moved nothing. The user's Escape inside the page put focus back on the card, with its focus ring. Show source showed the HTML, and Expand opened the page over the
  window while the card's own page stopped. Escape closed it, back on Expand.
- The fetch and the image were refused by the page's policy (`connect-src`, `img-src`). The links left the page where
  it was and opened no window. A fetch made by the session itself failed with `ERR_BLOCKED_BY_CLIENT`. The guest loading its page's
  address a second time was refused, and it still showed the first load's page.
- The session's own fetch failed with `ERR_BLOCKED_BY_CLIENT`. The session resolved a loopback address to its SOCKS5 proxy, not DIRECT, and the guest's WebRTC IP policy was `disable_non_proxied_udp`.
- With Let agents draw visuals in threads off, a new call was refused and drew nothing, and the page already in the thread opened again. The page showed in Figtree, loaded from the faces Sotto carried.
- With Reduce motion on, the page was told and its style stopped movement. A page whose body fills the frame grew to its 300 pixels of content.
- The listener saw no connection. No request completed but the pages, no frame committed a navigation but each
  guest's one load, and nothing downloaded.

## Captures

- `artifacts/interactive-visual/page-1280x800-dark.png` and `page-1280x800-light.png`: the card with its header
  ("Interactive page", Show source, Copy source, Expand), the page in the theme's colours and Figtree, and the intro
  and numbered steps under it.
- `page-1600x1000-dark.png` and `page-1600x1000-light.png`: the same at the largest size checked.
- `page-1280x800-dark-reduced-motion.png`: the card with Reduce motion on.
- `page-820x560-dark.png` and `page-820x560-light.png`: the minimum window. The card fits, and the page is clipped
  by the transcript above the composer like the rest of the thread.
- `page-step-2-1280x800-dark.png`: the walkthrough on step 2, and the page showing the step it was sent.
- `expanded-1280x800-dark.png`: Expand, with focus on Close.
