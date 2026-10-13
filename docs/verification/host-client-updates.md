# A host's client updates on its tiles: the built app over a scripted host

September 29, 2026, Windows 11, from `feat/host-client-updates` (#480, ADR-0042 as amended September 29).

## What was run

```sh
npm run build
npx playwright test tests/e2e/host-client-updates.spec.ts
```

The spec adds forge through the fake ssh (`tests/fixtures/fakeSsh.mjs`), which runs the real launch script and a real
headless host built from `tests/fixtures/e2eSshHost.ts`. That host's clients are forge's on September 29
(`tests/fixtures/clientUpdateProviders.ts`): Claude Code 2.1.281, Codex 0.155.1 and Grok Build 1.0.41, all connected, all
installed by mise in a real mise layout in the host's throwaway home (`installs/<tool>/<version>` with mise's own
`.mise.backend.toml`, and Grok Build's program in `~/.grok/bin`), and Devin not installed. The host reads each client's
channel from that layout with the production code. Only the registry's answers (2.1.284, 0.158.0, 1.0.43), the mise
binary and Grok Build's install step are stood in for: `mise upgrade` waits 0.7 s and moves the version, Codex's first
upgrade drops its download, and Grok Build's install step is held until the spec lets it go.

## What it showed

- The chip beside Show providers reads "3 updates" with the tiles closed, and each connected tile says what is available
  with Update beside Disconnect (`tiles-behind-820x560-dark.png`).
- Update on Claude Code's tile ran on forge, and the tile then said "Claude Code is now 2.1.284.".
- Enter on the chip opened "Client updates on forge" with focus on Update all. Update all ran Codex and then Grok Build,
  one at a time; while Grok Build's install step was held the row read "Step 2 of 2", the tile "Updating to 1.0.43 · step 2
  of 2…" and the chip "Updating 2 of 2". At 820x560 the popover opened above the chip, clear of the window controls
  (`updating-820x560-light.png`).
- Codex's dropped download did not stop Update all: it ended "Updated Claude Code and Grok Build on forge. Codex did not
  update.", with "The download dropped partway. 0.155.1 is still installed." and Try again on Codex's row, and the chip read
  "1 did not update" (`one-failed-1600x1000-light.png`).
- Escape closed the popover onto the chip. Codex's tile kept one line and Try again; its Details held the long
  explanation, "Or run this on forge:" with `mise upgrade codex` and Copy, and "What mise printed"
  (`failed-tile-1280x800-dark.png`).
- Try again on Codex's row updated it; the popover said "Updated 3 clients on forge.", Done took the chip away and focus
  went back to Hide providers. The host's readings at the end are in `client-updates.json`.

Every step was captured at 1600x1000, 1280x800 and 820x560, dark and light, with reduced motion on, and nothing scrolled
sideways; the four images above are in `artifacts/host-client-updates/`.

## What was not run

Nothing here ran on a real host. The mise channel's detection was checked against forge's own layout, read without
changing anything, on September 29; `mise upgrade` and Grok Build's install step were not run by Sotto on forge. The owner's
live check is to press Update all on forge the next time its clients fall behind.
