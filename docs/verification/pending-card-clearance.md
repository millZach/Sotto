# A waiting card's choices clear of the composer, and a readable placeholder

October 29, 2026. The branch `fix/composer-hint-and-card-clearance` from `main` at 5fb4a2e97, closing #1819 and #1820 from the desktop UI review (`docs/research/2026-10-29-ui-hillclimb-desktop.md`, findings 1 and 2). Checked on forge (Linux, Omarchy) in an owned nested desktop through `scripts/verify-linux-window-minimum.mjs --exec`, with the built app and the `design-threads` fixture. Not checked on Windows or macOS.

## What was wrong

**The placeholder (#1819).** The prompt editor's placeholder was muted ink let through at 55% (`--placeholder-ink` in `threads.css`). Held to the painted text pairs, it measured 2.3 to 4.3:1 on the composer card and the queue's edit field across the seven built-in themes, light and dark, and under 4.5:1 in every one; the review measured 2.38:1 in light and 3.38:1 in dark on its captures. It is solid muted ink now, as every other field's placeholder is.

**The card under the composer (#1820).** The transcript already kept the composer's height as its bottom padding and its scroll padding, so a transcript at its end had room for the last card. Two moves of that end were missed:

- A composer that grew under a reader at the end, as a draft of several lines does, changed only the transcript's own box. The transcript watched its content and nothing else, so it stayed where it was and the card's Deny and Allow went under the composer by the growth.
- Opening a thread on such a draft moved the end on before the transcript's own scroll to the end was heard. When it was heard, the end was 67px further away than the slack that counts as following, so the transcript took its own scroll for the reader leaving the end and stopped following. Measured on the build before the fix: `scrollTop 54`, `scrollHeight 637`, `clientHeight 516`, Deny's foot at 460.5 against the composer's top at 426.5.

The transcript now watches its own box as well as its content, and its own move to the end, heard after the end moved on, is followed to the new end.

## How it was run

```sh
npm run build
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/pending-card-clearance.spec.ts tests/e2e/composer-float.spec.ts
npx vitest run --maxWorkers=2 tests/unit/renderer/themeTokens.test.ts tests/unit/renderer/glassTheme.test.ts tests/unit/shared/omarchyThemes.test.ts tests/unit/renderer/threadWorkspace.test.tsx
```

`pending-card-clearance.spec.ts` sizes the window to 820x560 and opens Visual gate flake, which waits on a permission, from the sidebar, twice, from two other threads. Each time Deny and Allow must sit wholly above the top of what the composer draws, and a press at each one's middle must reach it. It then types a three-line draft, checks again, opens another thread and comes back to the draft, and checks again. Last, for each of Deny and Allow, it scrolls the button under the composer, focuses the control before it and presses Tab: the focused button must come clear of the composer (WCAG 2.4.11). On the build before the transcript fix the spec failed at the draft and at the reopening; the Tab checks passed before and after, because the scroll padding already held. `composer-float.spec.ts` passed alongside it.

`themeTokens.test.ts`, `glassTheme.test.ts` and `omarchyThemes.test.ts` now hold the placeholder, read from `threads.css`, to 4.5:1 on the composer card and on the field a queued message is edited in. With the old ink, `themeTokens.test.ts` fails 14 cases, every built-in theme in both appearances.

## What the captures show

- `artifacts/pending-card-clearance/opened-820x560-light.png`: the waiting thread opened at 820x560 in light, Deny and Allow above the composer, and the placeholder "Queued until you answer the card" in solid muted ink.
- `artifacts/pending-card-clearance/reopened-on-draft-820x560-dark.png`: the same thread opened again on a three-line draft, the card's choices still clear of the taller composer.
- `artifacts/pending-card-clearance/tabbed-allow-820x560-dark.png`: Allow reached by Tab from under the composer, focused and clear of it.

## Limits

- The review's own path, with the slim composer and the Needs you list on screen, was not driven by hand; the spec covers the two moves of the end that left the card under the composer.
- The next prompt's ghost keeps its translucent ink (PR #1510), outside the text pairs, as before.
