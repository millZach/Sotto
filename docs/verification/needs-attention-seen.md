# A failed row clears once it is seen, with Dismiss all

October 19, 2026. Branch `fix/needs-attention-clears-when-seen`, from `339378ce2` on `origin/main`. Records [ADR-0092](../adr/0092-a-failed-turn-is-attention-until-a-client-shows-it.md), the prototype's variant A as Zach picked it (`docs/prototypes/needs-attention-clear-prototype.html`), checked in the built app on Windows 11.

## What was run

`tests/e2e/needs-attention-seen.spec.ts` launches the built app with the unpackaged E2E host. Its provider reports a thread's history and status, and the thread is named after its first message, **Rename the settings keys**. Everything between that host and the window is the real coordinator, host service and renderer.

- **Before opening.** With **Docs** open in the pane, the provider reports the other thread's turn failed, with the reason "Claude returned an error: the API was overloaded. …" on its turn record. Its row says **Needs attention** in amber. Under the search a line reads **1 needs attention** with **Dismiss all** beside it, and the button's accessible name is "Dismiss Needs attention on 1 thread".
- **Opening it.** The window takes the focus, since a pane shows its thread only then (ADR-0046), and the thread is opened. Its row reads **Done**, without amber or the ring's colour, and the count line goes. The pane shows the reason once, on the failed turn's line in the transcript: there is no banner and no notice repeating it. Opening Docs and then the thread again keeps it Done with the reason still shown, and the host's shell carries `failureSeen: true` for it.
- **No reason on record.** The thread runs again and its next turn fails without a reason. It is open, so it is seen at once and stays Done. A notice above the composer reads **The last turn failed.** "Nothing in the transcript was lost. Send a message to try again."
- **Dismiss all by keyboard.** In a new launch, Docs waits on a permission and the other thread's turn fails while Docs is open. The rows say **Needs your approval** and **Needs attention**, and the line counts one, since the approval is never counted. With focus in the search field, `Tab` reaches **Dismiss all** and `Enter` presses it. The line goes, the search field has the focus again, the failed row reads **Done** without being opened, and Docs still says **Needs your approval**.
- **The next failure.** The same thread runs again (its row reads Working) and fails again. It says **Needs attention** and the line counts one again.

Both journeys passed (2 passed, 21 s).

## Fit and contrast

At 1600x1000, 1280x800 and 820x560, in dark and light, the count line keeps one row. Neither it nor its button scrolls or clips: each one's scroll width is within a pixel of its client width, measured in the running app at every size. The line's text is the theme's warning text on the warning surface, and Dismiss all and the notice's lead are the theme's text on that surface, with the notice's body in secondary text. `themeTokens.test.ts` holds each of those pairs at 4.5:1 in every built-in theme, light and dark (`tests/fixtures/renderer/paintedTextPairs.ts`). The new styles read `--tt-*` tokens only.

## Captures

In `artifacts/needs-attention-seen/`, each at 1.5 device pixels per CSS pixel:

- `failed-row-{1600x1000,1280x800,820x560}-{dark,light}.png`: the failed row before it is opened, with the count line and Dismiss all.
- `opened-{1600x1000,1280x800,820x560}-{dark,light}.png`: the same thread opened, its row Done, the reason on its failed turn line.
- `notice-1280x800-{dark,light}.png`: a failure with no reason on record, explained above the composer.
- `count-line-{1600x1000,1280x800,820x560}-{dark,light}.png`: the count line beside a thread waiting on an approval, which it does not count.
- `dismissed-1280x800-{dark,light}.png`: after Dismiss all, the failed row Done and the approval still waiting, with focus in the search field.

The design baselines for the Threads page changed on purpose: the design fixture's **Streaming WAV stall** has failed, so the populated Threads captures now show **1 needs attention** under the search.
