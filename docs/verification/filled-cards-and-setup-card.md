# The last containers as fills, and a setup card that fits its step

October 30, 2026. The branch `fix/finish-filled-cards-and-setup-card` from `main` at d5ec2219b, closing #1831 and #1824 from the desktop UI review (`docs/research/2026-10-29-ui-hillclimb-desktop.md`, findings 13 and 6), approved as proposed in `look-fixes-prototype.html` on the tag `prototype/ui-hillclimb-desktop`. Checked on forge (Linux, Omarchy) in an owned nested desktop through `scripts/verify-linux-window-minimum.mjs --exec`, with the built app. Not checked on Windows or macOS.

## What changed

**Settings › Dictation (#1831).** The Microphone test is a row on the Microphone card like the two above it: its label over its description on the left, the level and **Test microphone** at the row's end, and what the test found under both. The outlined box inside the card is gone, and so is the idle line "Run a quick input-level test.", which repeated the description.

**Settings › Hosts & phones (#1831).** This computer and Tailscale are one card, the remote hosts another (with "No remote hosts yet." as its row), and Phones a third: Let phones connect, its three checks as rows, and Pair a phone as a row with its button. The dashed pairing box is gone; a host's provider that is not installed loses its dashed tile too. The name phones show is a row on its own card.

**First-run setup (#1824, #1831).** The card is a fill with no outline, and as tall as its step, up to the window, from the top of the room so the progress stays put. Inside it the agents list, the project and computer rows, the empty-computers note, the iPhone's steps, the theme tiles, the speech models, the shortcut, the microphone test and Omarchy's pieces are fills of the inset with no edge. The chosen theme and speech model wear the selected card. Notes that say what went wrong lose their coloured edge and tint. On the Agents and Elsewhere steps (the coding agents, the first project and other computers), Skip for now is the filled button until the step's task has started, and **Choose a folder** and **Add a computer** are secondary; on the iPhone step, **Get the iPhone beta** is secondary beside **Finish setup**.

## How it was run

```sh
npm run build
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/filled-cards.spec.ts
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/first-run-setup-fit.spec.ts
```

`filled-cards.spec.ts` (2 passed) opens Settings › Dictation and Settings › Hosts & phones in dark, light and dark with reduced motion at 1600x1000, 1280x800 and 820x560. On each page no element is drawn with a dashed edge or a solid outline all round anything taller than a control; the Microphone test's description starts within 12 pixels of its label; Hosts & phones has its three cards; and the design captures' clipping check passes.

`first-run-setup-fit.spec.ts` (1 passed) now walks every step, ten on Linux, at 1080x720, 820x560, 1280x800 and 1600x1000, light and dark, after the microphone test has heard a voice. At 1600x1000 and 1280x800 no step scrolls and none leaves more than 40 pixels of empty card under its last block. At every size the footer sits under the step's body, the card stays inside the window and nothing is wider than it, and the card has no outline. On the coding agents, first project and other computers steps Skip for now must be the filled button. Only the coding agents step, with six clients listed, scrolled: by 22 pixels at 1080x720 and 49 at 820x560, as a whole under its footer.

## What the captures show

- `artifacts/filled-cards-and-setup-card/microphone-dark-1600x1000.png` and `artifacts/filled-cards-and-setup-card/microphone-light-820x560.png`: the Microphone card, the test a row with its words beside its label and the level and button at its end.
- `artifacts/filled-cards-and-setup-card/hosts-light-1280x800.png` and `artifacts/filled-cards-and-setup-card/hosts-dark-reduced-motion-1600x1000.png`: This computer and Tailscale on one card, the remote hosts on another.
- `artifacts/filled-cards-and-setup-card/phones-dark-1280x800.png` and `artifacts/filled-cards-and-setup-card/phones-light-820x560.png`: Phones on one card, its checks as rows and Pair a phone as a row with Show a pairing code; the name on its own card.
- `artifacts/filled-cards-and-setup-card/setup-agents-dark-1600x1000.png`: setup's coding agents step whole at 1600x1000, Check again above the footer and Skip for now filled; the review had it cut off under the footer.
- `artifacts/filled-cards-and-setup-card/setup-agents-dark-820x560.png`: the same step at the minimum, its body scrolled as a whole above the footer.
- `artifacts/filled-cards-and-setup-card/setup-computers-light-1280x800.png`: other computers, a short card, Add a computer secondary and Skip for now filled, the note a fill.
- `artifacts/filled-cards-and-setup-card/setup-look-dark-1280x800.png`: the look step's filled tiles and the chosen one in the selected card.
- `artifacts/filled-cards-and-setup-card/setup-microphone-light-1600x1000.png`: the microphone step after its test heard a voice.
- `artifacts/filled-cards-and-setup-card/setup-iphone-light-820x560.png`: the iPhone step, Get the iPhone beta secondary beside Finish setup.

## Limits

- The captures come from this branch alone, so setup's step line is still in capitals ("STEP 7 OF 10 · CODING AGENTS"); #1872 changes it.
- The coding agents step's clients were not connected in the run, so its rows read "Not checked yet"; a row's own state and Install guide were not drawn.
- A remote host's row, its provider tiles and a pairing code on screen were not opened in the running app.
