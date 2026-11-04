# Codex audit question cards (throwaway mock-up)

A throwaway HTML mock-up made on 2026-11-04 for Zach's choices on issues #2149, #2153, #2154, #2158, #2159 and #2161.
It is not product code and nothing in `src/` reads it.

Open `index.html` in a browser. The bar at the bottom switches the variants of the section in view, and the address
keeps the pick: `#<issue>-<letter>`, for example `#2149-B`. Two sections take an extra word: `#2149-A-github` shows the
GitHub tool approval in place of Computer Use, and `#2161-B-foot` turns on the menu's foot line. `?bare` shows only the
hashed section's window, filling the viewport, as the screenshots in `shots/` do; `?theme=light` starts in light.

The Sotto styles inside it are copied from `src/renderer/src` at 1377a86fe; the fonts beside it are the repo's own
Figtree and Spline Sans Mono files. Once Zach has picked, keep it as the tag `prototype/rohit-codex-audit` and delete it
from any branch bound for `main`.
