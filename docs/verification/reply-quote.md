# Reply quotes (ADR-0129)

Proved in the built app on October 24, 2026, on an Apple silicon Mac, with `tests/e2e/reply-quote.spec.ts` (both tests pass). The images named here are in `artifacts/reply-quote/`; a run with `SOTTO_E2E_EVIDENCE=publish` writes every capture there, and only these are committed.

## What the run shows

- **A drag in a reply.** The fixture thread has two exchanges between earlier and later turns. A mouse drag over two sentences of the first reply shows **Add to prompt** with its chord hint (⌘⇧A on a Mac), within 24 pixels above the words and inside the transcript, the look of variant A in `docs/prototypes/reply-quote-prototype.html`. Its accessible name is "Add to prompt" and it carries `aria-keyshortcuts`. `button-1280x800-dark.png`, `button-1600x1000-light.png`, `button-820x560-dark.png`.
- **Escape** puts the button away and ends the selection.
- **Nothing for the wrong selection.** A drag from the first reply into the second, and a drag over the user's own message, show no button.
- **Near the top.** With the reply's first line scrolled to the top of the transcript, the button stands under the words instead of being cut off, and stays inside the transcript. `button-near-top-1280x800-light.png`.
- **At each size.** At 1600x1000, 1280x800 and 820x560, dark and light, the button stays inside the transcript and no button, chip or composer runs past the window.
- **The press and the chord.** **Add to prompt** puts the words on the composer as a chip, `“Read the saved draft synchronously when…”`, ends the selection and puts the caret in the composer. Ctrl+Shift+A (Command+Shift+A on the Mac) adds a second the same way, and a third is added by the button. `chips-1280x800-dark.png`, `chips-1600x1000-dark.png`, `chips-820x560-light.png`, where the third chip wraps to its own line.
- **Reduced motion.** With **Reduced motion** on, the button runs no animation. `button-and-chips-1280x800-dark-reduced-motion.png`.
- **Remove quote** takes the third chip off and hands focus to the chip before it.
- **The send.** `Do the first one.` goes with the two remaining quotes, and the fixture provider records exactly:

  ```
  From your earlier reply:
  > Read the saved draft synchronously when the editor mounts, so the first render already has it.

  From your earlier reply:
  > The first is smaller and keeps one source of truth.

  Do the first one.
  ```

  The chips clear and the composer is empty; the user's bubble draws each quote as a blockquote. `sent-1280x800-dark.png`.
- **Off on stable.** With `reply-quote` off, the same drag selects the words and shows no button, and Ctrl+Shift+A adds nothing.
- **No page errors** through the run.

## What I worked out

- The button is placed over the selection's whole bounding box, centred, as the prototype does. For a selection over two lines it sits over their middle rather than their start; the run shows it still stands beside the words and inside the transcript.
- The light theme's raised surface is close to the room's colour; the hairline and shadow keep the button apart from the text under it, as in the prototype, so no change was made.
- The spec turns the slim composer off, so the composer keeps one size while the transcript scrolls under a selection.
- These captures are from macOS only; Windows was not run. The design matrix has no selection and no quote chip, so no baseline changed. On this Mac `npm run design:verify` fails five captures (`onboarding-step-4-speech-model-light.png`, `onboarding-step-1-welcome.png`, `scale-100-onboarding.png`, `threads-populated.png`, `widget-permission-light.png`) by exactly the same pixel counts on `origin/main` as on this branch; the baselines are Windows captures.
