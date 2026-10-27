# The queue tray without an edge, and the working line without its clock: verification

October 26, 2026, on Windows 11 with the built app (`npm run build`). It covers two changes Zach asked for: the queued messages' tray above the composer loses its thin border in every state, as the composer has none, and the working line goes back to the Spaceballs words alone ([ADR-0134](../adr/0134-a-running-turns-steps-fold-under-its-working-words.md), second October 26 amendment).

## How it was run

```sh
npx vitest run tests/unit/renderer/threadActivity.test.tsx tests/unit/renderer/threadWorkingDisplay.test.tsx tests/unit/renderer/ownServerTurn.test.tsx tests/unit/renderer/threadQueueSkills.test.tsx tests/unit/renderer/themeTokens.test.ts tests/unit/release/adrNumbers.test.ts tests/unit/shared/watcherGlossary.test.ts tests/unit/shared/iosWorkingWords.test.ts
npm run build
npx playwright test tests/e2e/thread-activity.spec.ts tests/e2e/queued-steering.spec.ts
```

The captures came from a throwaway Playwright script, run once on the unchanged build and once on this one: the full app with the fake Claude Code provider (`queued-steering` scenario) for the tray, and the thread activity fixture's running turn for the working line, since the fake provider's turn reports no start time and so never showed the clock. The light is held 1.55 seconds into its cycle so the stills show it in the letters.

## The queue tray

`before-compose-dark.png` and `before-compose-light.png` show the tray with a hairline round its top and sides. `after-compose-dark.png` and `after-compose-light.png` show it with none: it still reads as its own place through its surface, a step between the card and the pane, and it still tucks under the composer card. `after-queue-hover-dark.png` holds a pointer over the row and `after-queue-folded-light.png` the folded tray; neither draws an edge. The ring round **Queued** in the light captures is that button's keyboard focus ring, which stays.

## The working line

`before-working-line-dark.png` and `before-working-line-light.png` read "Combing the desert 1m 06s". `after-working-line-dark.png` and `after-working-line-light.png` read "Combing the desert" and the chevron, with the light crossing the letters as before.

The clocks that do not sit beside the words are kept: a running step's own clock in the opened steps, which `thread-activity.spec.ts` still watches tick, and the line for a turn on one of the user's own servers that has waited 30 seconds.

## Not passing

`restored history reads as unknown and trimmed, never as success` in `thread-activity.spec.ts` times out on this machine with or without this change (checked with the three changed source files put back to `main`). It does not touch the working line or the queue.
