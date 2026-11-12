# A thread's click on a scrolled page

November 12, 2026, Windows laptop.

## What went wrong

In thread 6a27526e every `click` failed with "This tool is unavailable. Refresh and try again." after the agent scrolled a Porkbun page. Navigate, key presses, screenshots, scrolls and inspecting still worked. Before each click, Sotto checks the element the click will reach with `DOM.getNodeForLocation`. Chromium reads that point in the document, but the agent's point is in the visible page, as a screenshot is. So on a scrolled page the check looked at a spot above the one the click would press. When that spot was above the visible part of the page, Chromium answered "No node found at given location", and Sotto reported that protocol error as the tool breaking. Nothing was stored: the page stayed scrolled, so every later click failed the same way.

The same refusal came back on a fresh example.com page when the agent clicked at 300, 300 without taking a screenshot first. That point was outside what the page showed. Now it is refused in words that give the visible size.

## What was checked

- **The installed app, before the fix.** On a tall local page in this thread, a click at 300, 100 worked. After a 1400-pixel scroll, the same click failed with the exact message, while a click at 300, 1500 passed the check. With a 400 by 240 viewport scrolled to the top, a click at 100, 100 worked and one at 300, 300 failed the same way.
- **The built app (`tests/e2e/browser-hidden-page-input.spec.ts`).** The agent scrolls a hidden page, then clicks at 100, 100. Without the fix the click returns `{"code":"unavailable","message":"This tool is unavailable. Refresh and try again."}`. With the fix it lands on the note at that point of the scrolled page.
- **A real Chrome (`tests/integration/hostBrowser.test.ts`, `SOTTO_REAL_BROWSER=1`).** The page is scrolled to 1400 pixels. Without the fix the target check throws `No node found at given location`. With the fix it finds the button 100 pixels down the view, the click presses it, and a point below the visible area is refused as `blocked`. This laptop's run pointed the host browser at Chrome by hand, since its finder looks only where Linux and macOS keep a browser. CI's Linux job runs it as written.
- **Unit (`tests/unit/main/browserTools.test.ts`).** A debugger that hit-tests in the document, as Chromium does, red before and green after.
