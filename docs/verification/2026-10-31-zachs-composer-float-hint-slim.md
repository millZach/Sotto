# Zach's composer: words behind it, a dimmer hint, and slim at every scroll

October 31, 2026, on forge (Linux), in the built app under Playwright and a virtual display, on the Owl track. Zach's report on Owl 0.1.42: the text no longer went behind the composer, the placeholder was the same colour as typed text, and in the threads view the composer slimmed on scroll-back only some of the time.

## What was wrong

- **Words behind the composer.** #1885 clipped the transcript at the composer's top (`clip-path` on `.thread-transcript__viewport`), so nothing scrolled under the card in any composer style, in threads or Watcher. #1928 did not cause it; both shipped in the same Owl. The clip is gone. The bottom padding and the scroll padding #1885 tuned stay, so at the end the last line still clears the composer, and a focused line still clears the composer and Jump to latest.
- **The placeholder in typed ink.** Zach's Sotto on forge follows the Omarchy theme (tokyo-night). The Omarchy guard lifts the muted foreground all the way to the body text, so that Changes' line numbers read on selected diff rows. `--tt-text-muted` is built from the muted foreground, so on tokyo-night it was the body text exactly. The placeholder is now built the same way from the theme's own Muted text role (`textMuted`), which the guard keeps readable without lifting it to the body text. In T3 Code, Graphite, Clay, Fern and Glass the two roles are the same colour, so nothing changes there. In Hush and Citrine the hint is a little dimmer than before.
- **Slim only some of the time.** Three things kept an empty composer full while the reader scrolled. A composer with focus stayed full, and after a send, or on opening a thread, the caret rests in the empty prompt. The reader had to be more than 160 pixels above the end, which a wheel notch or two from the end did not reach. And the transcript told the pane only when the reader crossed that line, so a composer brought back full while reading back (a click or Tab) stayed full until the reader went back to the end and left it again. Both styles and Watcher did the same. Now every scroll away from the end slims an empty composer: the line is 48 pixels above the end, the slack in which the transcript still follows the end; the transcript tells the pane at each scroll the reader makes while reading back; and a caret resting in the empty prompt does not hold it full. A click, Tab or a key typed in the transcript still brings it back full until the next scroll, focus on any other of its controls keeps it full, and so does a draft.

## What was run

- `tests/e2e/composer-shrink.spec.ts`, now once for each style: 4 passed. With the caret in the prompt, reading back slims the composer and the prompt keeps focus; before the fix this failed in both styles (`slim: false` at 1,200 pixels from the end). Five rounds of back to the end and one real wheel notch up (120 pixels) slim it every time, with the caret in the prompt on alternate rounds, and three rounds of a press on the slim card then one notch slim it again each time.
- `tests/unit/renderer/slimComposer.test.tsx`: the same, scrolling 60, 100, 160, 400 and 900 pixels from the end in turn and slimming each time, then three presses on the card each followed by a scroll. Without the transcript telling the pane of each scroll, the second half fails at its first round.
- `tests/e2e/composer-float.spec.ts`: everything up to the waiting-question step passes. The strip beside the card reaches the transcript, the viewport has no clip, the last line clears the composer, and Jump to latest keeps 13 pixels of clear space above the scroll padding. The waiting-question step fails the same way on main's code (the stacked pane's transcript measures 0 tall at 1280x620 with three panes). That is a follow-up issue.
- `tests/e2e/watcher-column.spec.ts`, "floats as glass": the float checks pass, including the strip beside the card. The later step that reads Jump to latest after slimming finds no Jump button, the same as on main's code. Also a follow-up issue.
- The painted text pairs over all 22 stock Omarchy palettes and every built-in half: the placeholder reads at 5.3:1 or better on the composer card. It now stands 1.24 to 2.23:1 apart from typed text in Omarchy, where 13 palettes were below 1.2 and 7 were exactly 1.00 (tokyo-night among them). In the built-ins it stands 1.87 to 2.82:1 apart. `themeTokens.test.ts` and `omarchyThemes.test.ts` now hold it at 1.2:1 or more apart.

## Captures (`artifacts/zachs-composer-fixes/`)

- `rows-end-dark.png`, `rows-end-light.png`: Zach's composer at the end, the caret in the prompt, the last line clear of the card.
- `rows-reading-back-caret-dark.png`, `rows-reading-back-caret-light.png`: reading back with the caret still in the prompt. The composer is slim and the conversation runs on under it.
- `pill-end-dark.png`, `pill-reading-back-caret-dark.png`: the same in Drake's composer.
- `watcher-reading-back-caret-dark.png`: Watcher's conversation passing under its slim, frosted composer.
- `rows-placeholder-omarchy-tokyo-night.png`, `rows-typed-omarchy-tokyo-night.png`: the hint and typed words in the Omarchy tokyo-night theme. The hint is dimmer, by as much as that palette's own muted text is.

No capture shows an edge on the composer.

## Not checked here

- Windows and macOS. The design baselines that show an empty composer in Hush or Citrine may move by the hint's small change; the committed baselines are T3 Code, which does not change.
