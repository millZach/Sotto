# A running turn's steps under its glowing working words: verification

October 24, 2026. `feat/turn-steps-glow`, on Windows 11 with the built app (`npm run build`) and the thread activity fixture, which mounts the real Threads page with a stubbed agent connection. It covers [ADR-0134](../adr/0134-a-running-turns-steps-fold-under-its-working-words.md), Zach's pick of variant A of `docs/prototypes/turn-steps-glow-prototype.html`, and the iPhone's half in ADR-0051's October 24 amendment.

## How it was run

```sh
npm run typecheck
npm run lint
npx vitest run tests/unit --maxWorkers=4
npm run build
npx playwright test tests/e2e/thread-activity.spec.ts tests/e2e/thread-thinking.spec.ts --timeout=180000
npm run design:capture
npm run notices:verify
```

The thread activity spec builds its fixture in a `beforeAll` hook that took 36 seconds on this machine, past the 30-second default, hence the longer timeout. The fixture had not drawn anything since the interface moved to Lingui (ADR-0123): its Vite config had no Lingui plugin, so the page threw on the first macro and every test in the spec failed at launch. The fixture now builds with the same plugin as the renderer.

## The working line

On a running Codex turn the line at the end of the transcript reads only the working words and a chevron (`live-1280-dark.png`): no clock, no step named, and none of the turn's rows in the transcript. Its button is named "Working, 3 steps so far" and reads `aria-expanded="false"`. The words carry the `thread-activity-glow` animation and the dot beside them is hidden while it runs.

`glow-frames-dark.png` and `glow-frames-light.png` are the line photographed every 450ms at twice the pixel density: the band of accent text colour crosses "Combing the desert" in dark and "Merchandising" in light, then rests with the words in the muted ink. Both inks pass 4.5:1 on the canvas in both modes.

Enter on the line opens the steps under it (`live-open-1280-light.png`): the reasoning summary, the subagent with its two agents, and the running `npm test` with its clock ticking, as the live rows were drawn before. Escape inside an opened row folds the row, and the next Escape folds the steps and leaves focus on the line. Nothing overflows sideways at 1280 or at the 820 minimum.

With reduced motion on, the words do not move and the dot stands still beside them (`live-820-reduced-motion-light.png`, at the 820 minimum). Disconnected, the line reads Last seen working with no words and no clocks, and still opens to rows that read Last seen running in the muted ink.

## A finished turn

The settled turn's line reads "Worked for 2m 04s · 7 steps". Opened, its groups keep their counts, and the failed `npm run lint` is no longer drawn beside a folded group; it shows as failed once its group opens. The turn's own error stays in view.

## Edge cases covered by unit tests

- A turn with no step yet: the line is only its words, not a button, and gains the button with its first step (`threadActivity.test.tsx`).
- The next turn starts folded even when the last turn's steps were left open, because the line stays mounted between turns.
- A turn on one of the user's own model servers that OpenCode is trying again (ADR-0124): the retry line keeps its words and Stop, and adds a "1 step" button that opens the steps taken before the retry and folds on Escape (`ownServerTurn.test.tsx`).
- A turn that compacts its context part-way: the Compacting context line keeps a "1 step" button that opens the turn's steps and folds on Escape (`threadWorkingDisplay.test.tsx`).
- Watcher's conversation: a news turn's work folds under the working line rather than above the reply being written, and your finished turn's Worked for line counts its steps (`watcherNewsTurns.test.tsx`, `watcherView.test.tsx`).
- A remote host's cut bodies: the opened steps sit inside the transcript's activity body provider, so a cut command, diff or thinking row reads whole from its host when opened, as it did in the transcript.

## Design captures

`npm run design:capture` rewrote 91 baselines. Eight changed because of this work and are committed: `threads-populated`, `threads-open-running`, `threads-split-focus-820` and `threads-split-workspace`, each in dark and light, where the working line lost its dot and took the muted ink of the glow's resting frame. The other 83 changed for reasons already on `main` (the sidebar's Dictate and Threads switch, settings, themes, onboarding, dictation and the widget) and are left for a refresh of their own. Those eight images carry that sidebar change too, since they are captures of the whole window.

## Not verified

- The iPhone on a device. Its Swift cannot be built on Windows; the macOS CI job on #1523 built it and passed the native protocol tests. `iosWorkingWords.test.ts` checks its word list against the desktop's, and `StepRunTests` checks the word order and that a word never follows itself.
- Watcher's pane in the running app. Its conversation draws turns with the same components as a thread, and the unit tests above cover its news turns; no capture of a working Watcher was taken.
- `tests/unit/release/stableHostPromotion.test.mjs` fails on this machine because its Node is older than the 24.22.1 the host archive needs. It is unrelated to this change.
