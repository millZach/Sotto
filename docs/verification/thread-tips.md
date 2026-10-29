# A tip under the working words: verification

October 28, 2026. `feat/thread-tips`, on forge (Omarchy Linux) with the built app (`npm run build`), on Owl, in an owned nested desktop. It covers [ADR-0159](../adr/0159-tips-come-from-what-they-point-at.md) and issue #1767: Zach's pick, variant B of `docs/prototypes/thread-tips-prototype.html` with a lightbulb in place of the word "Tip", one tip per turn, and Show hidden tips again in Settings.

## How it was run

```sh
npm run typecheck
npm run lint
npm run notices:verify
npx vitest run tests/unit/renderer/threadTips.test.tsx tests/unit/scripts/checkTipSources.test.ts tests/unit/renderer/threadActivity.test.tsx tests/unit/shared/settings.test.ts tests/unit/shared/interfaceCatalogs.test.ts tests/unit/renderer/features/settings/settingsReachable.test.tsx tests/unit/renderer/themeTokens.test.ts tests/integration/settingsHistoryIpc.test.ts
npm run build
node scripts/verify-linux-window-minimum.mjs --exec /usr/bin/env SOTTO_E2E_EVIDENCE=publish "$PWD/node_modules/.bin/playwright" test tests/e2e/thread-tips.spec.ts
node scripts/check-tip-sources.mjs
```

The spec passed, 3 of 3. The wrapper then reported a cleanup failure about `~/.sotto`, which the live headless host on forge rewrites all the time; the spec does not write there. The full suite runs in CI on the pull request, not on forge.

## Under a working thread

`claude-1280x800-dark.png` and `claude-1280x800-light.png` show a Claude thread at work: "Combing the desert", and under it the hook, the lightbulb and "Claude reads CLAUDE.md at the start of every session. Ask it to add a rule there instead of repeating yourself." with Hide. The spec checks the tip is the element straight after the working words, its hook within 1px of where the words start, the lightbulb within 1.5px of the centre of the tip's first word, the tip text at 4.5:1 or better in dark and light, and the composer with no edge. It keeps the same tip through the change of look.

`claude-820x560-dark.png` is the 820x560 minimum: nothing clips, and neither the tip nor the transcript scrolls sideways. `claude-1280x800-dark-reduced-motion.png` is reduced motion: the still dot beside the words, the hook still under them, and no animation on the tip.

Hide takes the tip away, puts focus back on the working line and records the tip's id. A later step in the same turn brings no tip back, and the next turn shows a different one.

## Codex, another provider, and Watcher

`codex-1280x800-dark.png` shows a Codex thread with a Codex tip ("Codex reads AGENTS.md before it does any work."). Both thread captures start the rotation one place in, so the provider's own tip shows rather than the first Sotto tip. `grok-1280x800-dark.png` shows a Grok thread, which gets a Sotto tip only ("Right-click a link in a reply, or press Shift+F10 on it, to choose where it opens."). OpenCode is not in the design fixture; Grok stands in for every provider other than Claude Code and Codex.

`watcher-1280x800-dark.png` and `watcher-1280x800-light.png` show Watcher's own thread at work, with one of the tips Watcher's line can show under its working line ("Right-click a link in a reply…" in light). Nothing about the night scene changed, and the tip takes the same glow as the conversation's other words.

## Settings

`settings-threads-tips-dark.png` is Settings › Threads › In a thread: **Show tips while threads work**, on, and under it **Show hidden tips again** with "1 tip hidden or used." The spec turns the switch off and the tip leaves the working thread, and `threadTips: false` is saved. It turns the switch back on and the same tip returns. Show hidden tips again then clears the list and reads "No tips are hidden.", disabled. On stable there is no tip and no switch.

## Tip sources

`node scripts/check-tip-sources.mjs` read the four documentation pages the doc tips cite and found each sentence: "Checked 4 tip sources: 0 changed, 0 unreachable." The weekly workflow has not run yet; it runs first on GitHub.

## Not checked here

- Windows and macOS. Linux is checked on forge (ADR-0062). The dictation tip is left out on Linux, so it shows in no capture.
- A skill tip from a loaded catalog. The design fixture lists no skills; `threadTips.test.tsx` covers it, including Try it putting `/deploy` in the prompt.
- The design captures have no running turn, so their baselines do not change.
