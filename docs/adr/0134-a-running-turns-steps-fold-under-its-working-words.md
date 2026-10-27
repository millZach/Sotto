# A running turn's steps fold under its working words

## Status

Accepted October 24, 2026. Zach picked variant A, **Quote only**, of `docs/prototypes/turn-steps-glow-prototype.html` (tag `prototype/turn-steps-glow`), with the slower glow in the accent light, no sign of a failed step on the line and no clock. It goes straight to stable. It changes how [ADR-0051](0051-the-iphone-takes-the-glow-look.md) draws the iPhone's working line (see its October 24 amendment). **Number provisional until merge** (docs/agents/domain.md).

## Context

While a turn ran, the desktop listed its steps as it went: a row for each command, edit, tool call and agent, the newest six in view, between the user's message and the reply. Under them the working line said "Working for 1m 4s" and the step running now, or carried the wait with the Spaceballs words ("Combing the desert") when it had no step to name. A busy turn filled the transcript with rows the reader did not ask for, and pushed the replies written on the way apart. A finished turn already folded all of it under one **Worked for** line, but it kept every failed step in view beside that line.

Zach asked for the steps to shrink under the words, with a slow glow crossing the words while the model works, and for a press on the words to open the steps. The prototype tried three lines on desktop threads, Watcher's pane and the iPhone at 375 points, in dark and light: the words alone, the words with a step count, and the words with the step running now under them.

## Decision

**The working line.** While a turn runs, its steps are not drawn where they happened. The working line at the end of the transcript shows only the working words, with the chevron once the turn has a step. A band of the theme's accent light crosses the words in about three seconds, rests, and crosses again every 4.2 seconds; the dot that pulsed beside the words steps aside while the light moves. The words change every 3.8 seconds, as before. There is no clock on the line. Pressing the line, or Enter or Space on it, opens the turn's steps under it, the newest six with **Show N earlier**, as the live rows were drawn before. Escape inside the steps folds the innermost open thing, and Escape on the line folds the steps and leaves focus on it, as every disclosure in the transcript does. The line is a button named for the fact, not the words: "Working, 12 steps so far". Until the turn has a step there is nothing to open, so the line is only its words.

**Reduced motion.** With reduced motion on, nothing moves: the words hold their ink, the dot stays beside them, still, and the words change without fading.

**Disconnected.** While the provider is not connected, the line reads **Last seen working** with no light, and still opens to the steps.

**A finished turn.** The **Worked for** line counts the steps it holds: "Worked for 2m 04s · 12 steps". It still opens to the replies and work in between.

**Failures fold.** A failed step no longer stays in view on its own beside a folded line, on the working line or on a finished turn's. It shows as failed once the steps are open. The turn's own error, which says why the turn ended, stays in view as before.

**Where.** Desktop threads, threads beside Watcher, and Watcher's own conversation, which draws its turns the same way. On the iPhone the working run's line shows the same words with the same light, as ADR-0051's October 24 amendment says; its runs were already folded.

## Considered Options

- **The words with a step count** ("Combing the desert · 12 steps"). It says how far the turn has got without opening it. Zach chose the quieter line; the count is in the name assistive tech reads, and in the Worked for line once the turn ends.
- **The words with the step running now under them, in faint text.** It kept what the old line said. It made the line two lines tall and moved every few seconds.
- **A red dot or "1 failed" on the line.** A failed step is often one the agent then fixed, and the turn's own error already says when a turn ended badly.
- **Softer white light, and other speeds.** Zach preferred the accent light for how it looks; 4.2 seconds was the middle of three speeds.
- **A clock on the line.** The finished turn's line says how long it took, and the line is quieter without one.

## Consequences

- A busy turn takes one line until it ends, and the replies written on the way sit together.
- The steps of a running turn are one press away instead of in view, so a reader who watched commands run now opens the line to do it.
- The glow runs in CSS on the desktop, on the words alone, and in Core Animation on the iPhone, so neither redraws the transcript to move it.
- The Spaceballs words are written twice, in `ThreadActivity.tsx` and in the iPhone's `WorkingWords`; `tests/unit/shared/iosWorkingWords.test.ts` fails when the two differ.

## October 25 amendment: a light you can see, and the clock back

Zach found the light too faint to see and asked for the time the turn has been working beside the words. On a dark theme the muted ink and the accent's text tone are nearly the same lightness, so a band that blended one into the other changed only the hue, and only at its centre. He picked the letters lighting up with no accent halo, from `docs/prototypes/working-words-glow-strength-prototype.html`, with the clock after the words and nothing between them.

**The light.** The words keep their muted ink, and a copy of them in `--tt-working-light` shows only through a band that sweeps across them, as the iPhone already draws it. `--tt-working-light` is the theme's accent at its most vivid: lifted to at least 0.9 lightness in dark and deepened to at most 0.38 in light, with its chroma raised by half again up to 0.2, so the lit letters stand clear of the muted ink on every theme, however dull its accent. The band is wider at full strength than before, with no halo. The timing is unchanged: across in 72% of a 4.2 second cycle, then a rest. Reduced motion is unchanged: nothing moves, the words keep their ink and the still dot stands beside them.

**The clock.** The line now reads the words, then how long the turn has run ("Combing the desert 1m 04s"), in the muted ink a size smaller, counting from the turn's start, or from Send while the prompt is on its way. It uses the transcript's clock: whole seconds under a minute, then "1m 04s" and "1h 02m", and it updates its own text once a second without redrawing the transcript. Like every clock in the transcript it shows only while the provider is connected, so **Last seen working** has none. The button keeps its name, "Working, 12 steps so far"; a name that changed every second would be read out again and again.

This replaces "There is no clock on the line" above and the light's description in the Decision, and the considered option **A clock on the line** is now the decision. It applies to the desktop's threads, threads beside Watcher and Watcher's conversation. The iPhone keeps the light and line of ADR-0051's October 24 amendment, without a clock, until Zach asks for it there.

## October 26 amendment: the steps start as you last left them

Drake asked for the steps to remember being opened across the whole app: open one, and every later one starts open until he folds one; fold one, and they start folded until he opens one.

**One answer, kept.** A press on the working line, a **Worked for** line or the work in a Watcher reply's header sets whether a turn's steps start open (**steps opening** in `CONTEXT.md`). Every one of those lines the user has not pressed while it is on screen follows it at once, in every thread, beside Watcher and in Watcher's own conversation, and a new turn's working line starts from it. A line the user pressed keeps its own state while it stays on screen. The answer is a window preference in the renderer's storage, like the sidebar's width, so it survives a restart and has no Settings row.

**Groups follow, never set.** The groups inside an open fold ("Ran 2 commands, changed 1 file") follow the answer too, so an open fold shows its commands and thinking the way the open working line does. A press on a group keeps that group's own state without setting the answer, because the fold around it may be following the answer, and folding a group would otherwise fold the turn it sits in.

**Running turns.** Nothing was forced open while a turn ran: the working line started folded each turn, and the group under it, once opened, has no button of its own. So the answer replaces the working line's folded start, and nothing else about a running turn changed. A fold that opens itself, as **Show where it asked** opens one, does not set the answer. Escape folds only the line it is in: it is also how a pane beside Watcher is put away, one level at a time, and a key pressed to get out should not change how every other turn opens.

This replaces "starts folded" for the working line and "opens on a press" for the Worked for line in the Decision above; both still open and fold on a press, and Escape still folds one level at a time.

## October 26 amendment: the clock goes again

Zach changed his mind on the clock: the line should be the Spaceballs words alone, with the light crossing their letters. The line now reads only the words ("Combing the desert"), and the chevron once the turn has a step. The light, the words' timing, reduced motion and the button's name are as the October 25 amendment left them.

This takes back **The clock** in the October 25 amendment, so "There is no clock on the line" in the Decision holds again. Only the working line loses its clock. A running step's own clock in the opened steps ("Running 12s"), the line that says a turn on one of the user's own servers is still waiting (ADR-0124), the **Worked for** line and the held action's creature keep theirs, because none of them sits beside the words.
