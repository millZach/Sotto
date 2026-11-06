# A running turn's steps fold under its working words

## Status

Accepted October 24, 2026. Zach picked variant A, **Quote only**, of `docs/prototypes/turn-steps-glow-prototype.html` (tag `prototype/turn-steps-glow`), with the slower glow in the accent light, no sign of a failed step on the line and no clock. It goes straight to stable. It changes how [ADR-0051](0051-the-iphone-takes-the-glow-look.md) draws the iPhone's working line (see its October 24 amendment). **Number provisional until merge** (docs/agents/domain.md).

Amended November 4, 2026, by Zach's pick of variant B: the line names the step when one is known; and November 5, 2026, by his pick of B again: what the provider sent the step is for leads, with the step beside it (see the amendments at the end). Amended again on November 5, 2026, by his pick of C: when the agent sent a plan, its checklist stays in view above the line (see "the plan stays in view" at the end). Amended November 5, 2026, by his pick of B, "as long as that reply closes out the last step": a closing reply written after the turn's steps stands under the line (see "the closing reply under the line" at the end). Amended November 5, 2026, by his pick of B: the light is a band about ten letters wide that crosses the words, not a share of the line (see "the light passes as a band" at the end). Amended November 5, 2026, by his pick of B: while the steps are open, the line leaves the running step to its row and carries his words (see "the open steps name the running step" at the end). Amended November 6, 2026, by his pick of C, "command on demand": in opened steps a row says only what the step was for, and its command shows once the row is open (see "the command shows on demand" at the end). Amended November 6, 2026, by his pick of C, "quiet turns": a quick turn's **Worked for** line shows only under the pointer or the keyboard, and no rule parts a thread's turns (see "quiet turns" at the end). His picks of October 24 and 26 stay in the record below.

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

## November 4, 2026 amendment: the line names the step when one is known

Zach chose this. On October 24 he picked the quieter line, and on October 26 he said the line should be the Spaceballs words alone. On November 4 he tried both answers in the design pass's prototype `sotto-council/prototypes/working-line/index.html`, kept outside the repository, and picked B: the step when one is known, or his words.

**What the line says.** While a step runs, the line names it, in place of the words: "Running npm test", "Reading threads.css", "Editing control.ts". While the reply arrives it says "Writing a reply". When nothing is known, which is what thinking and a gap between steps are, his words carry the wait as before. It comes from real activity only, the same records the opened steps show, so every provider gets it, and it says only what that provider reports: a tool Sotto has no verb for reads as the tool's own name and input. A long command is cut with an ellipsis at the end of the line, with the light still crossing its letters.

**What stays.** The light, its timing, the chevron, reduced motion and the steps under the line are unchanged. There is still no clock and no sign of a failed step on the line. The count stays in the button's name and on the **Worked for** line, so there is no "Thinking" and no "3 of 7 done" on the line. The button keeps its name, "Working, 12 steps so far"; the step is its description, so a screen reader is not read a new name at each step.

**It does not flicker.** What is on the line holds it for at least 1.5 seconds, so a quick run of steps reads one at a time, and his words come back only after a gap of 1.5 seconds, so a short gap between two steps never shows. The line writes its own text, as the words always did, and works out what to say only when the turn's steps or its newest reply change, reading them without a copy, so a reply streaming in costs it nothing.

**What it costs.** The line moves more than the quiet one he chose. The wording is only as good as what each provider reports.

This replaces "shows only the working words" in the Decision and takes back the October 26 amendment's "the Spaceballs words alone" for a step that is known; the considered option **The words with the step running now under them** stays declined, since the step takes the words' place rather than a second line. The iPhone keeps its line (ADR-0051's October 24 amendment) until Zach asks for this there.

## Note, November 4, 2026: no group line in a one-group fold

Zach has not been asked about this yet. It came from the design pass of November 4, 2026 and no decision recorded it, so this records what the surface now does. He will be asked when he reviews that work, and nothing here says he picked it.

When a finished turn's fold holds one group of work and no replies, its rows stand straight under the Worked for line, with no group line and no fold of their own, since that line would only say again what the Worked for line says. A fold that holds more than one group, or replies between them, keeps each group's line. The Worked for line still counts the steps it holds.

## November 5, 2026 amendment: what a step is for leads the line

Zach chose this: on November 5 he tried both answers in the design pass's prototype `sotto-council/prototypes/working-purpose/`, kept outside the repository, and picked B.

While a step runs, or the reply arrives, and the provider sent what the work is for, the line leads with that and names the step beside it, a size smaller in the muted ink, with the light crossing only the leading words: "Ordering the cuts so each pull request is safe to merge alone" beside "Read how the workspace control tests build a coordinator", or "Read the request policy" beside `cat src/main/agents/requestPolicy.ts`. What the work is for comes from the plan's current item, in the words the provider gives a running step (Claude's `activeForm`) or as written; else from Claude's description of the command, which Claude Code sends with every shell command; else from the heading of the Codex reasoning summary that led to the step, and only while nothing has finished since that summary. When nothing was sent, the step names itself as the November 4 amendment says. At the minimum window only what the work is for shows, since the opened steps name the step. Thinking and a gap between steps still belong to his words, even when the plan has a step in progress, so the line is still one line with no count, no clock and no Thinking. The button keeps its name, and its description reads all of it, the command included.

## Note, November 5, 2026: a request waiting on the user takes the line

Zach has not been asked about this yet. It came from the design pass of November 4, 2026 and no decision recorded it, so this records what the surface now does. He will be asked when he reviews that work, and nothing here says he picked it.

While a permission request or a question waits on the user, the line says so: "Waiting for your permission", or "Waiting for your answer" when only a question waits, a permission outranking a question as it does in the sidebar and the composer. Before, a turn whose last reply came before the request read "Writing a reply" above the request's card, which was not true. It takes the place of the step and of what the step is for, and it holds the line for 1.5 seconds like anything else on it. The light, the chevron, the steps under the line and the button's name are unchanged.

## November 5, 2026 amendment: the plan stays in view

Zach chose this: on November 5 he tried three answers for how a running turn reads while its steps are folded, in the design pass's prototype `sotto-council/prototypes/working-view/`, kept outside the repository, and picked C. At the start of that work he had said he likes how Claude shows a little dropdown of the steps it is going through. A was the line as the amendment above leaves it, one line with what the step is for leading. B was two lines: what the work is for with how far the plan had got ("3 of 7 done") beside it, and the step running now under it.

**The checklist.** When the agent has sent a plan (Claude's TodoWrite, Codex's plan updates, or any plan another adapter reports), its items stand above the working line while the turn runs, as a small checklist: the opened plan's own list a size smaller, one line an item, with its tick for done, the accent dot for the item in progress and the ring for what is to come. It is the newest plan the turn sent, and its items are as written, not in the words for running. An item that moves on fades into its new mark; under reduced motion it changes without fading. A long item is cut at its end, and the opened plan reads it whole. At the minimum window the checklist is the same list. Assistive tech reads it as a list named for its progress, "Plan, 3 of 7 done", and is not told when it changes.

**The line under it.** The line no longer leads with the plan's item, since the checklist shows it. It says what the running step is for when the provider sent that, Claude's description of a command or the heading of the Codex reasoning summary that led to it, with the command beside it, and otherwise names the step, as the November 4 amendment says. Commands stay folded under the line, one press away, and the plan is still one of the steps there. When no plan was sent, the line is as the amendment above says.

**What stays.** The light with no accent halo, the words' timing, no clock, no count on the line and no sign of a failed step. A request waiting on the user still takes the line, with the checklist above it. At the minimum window the line keeps only what the work is for. Once the turn ends, the checklist goes with the working line: the **Worked for** line says how far the plan got ("plan 7 of 7 done") and opens to the plan, as it does for every finished turn.

**What it costs.** A turn with a plan takes as many rows as the plan has, above the line, at every width.

The considered option **The words with the step running now under them** was turned down on October 24 because it made the line two lines tall and moved every few seconds, and B brought that second line back. The checklist is Zach's answer to that: the plan is in view, the line stays one line, and the checklist moves only when the plan does. The earlier record stands. This replaces "from the plan's current item" in the amendment above for a turn with a plan in view; the iPhone keeps its line (ADR-0051's October 24 amendment) until Zach asks for this there.

## November 5, 2026 amendment: the closing reply under the line

Zach chose this: on November 5 he compared two answers for where the reply being written sits while a turn with steps runs, in the design pass's prototype `sotto-council/prototypes/reply-order/`, kept outside the repository, and picked B, "as long as that reply closes out the last step." A was this decision as written: the working line, and the plan's checklist above it, at the end of the transcript, under the reply being written. B was the reply under the line.

**Where the reply stands.** While the running turn writes its closing reply, the one after its last step, that reply stands under the working line, where the **Worked for** line will stand above it once the turn ends. The screen reads in the order the work happened: the message, the plan, the line with the steps folded under it, then the reply. The line keeps its place as the words arrive rather than being pushed down by them, and does not move or remount when the turn ends; only the reply is drawn in its new place.

**When it goes back.** Zach's condition holds it to the closing reply. Once a step, a permission request or a question follows the reply, it is no longer the turn's last word, and it goes back above the line in the order the work happened, with the line and the request's card at the end. A turn with no steps keeps its line at the end, since nothing will fold above its reply, and a reply written before the turn began is not the one being written.

**What stays.** "The working line at the end of the transcript" in the Decision now means the end of the running turn's work. The line's words, light, timing, checklist and press are unchanged.

## November 5, 2026 amendment: the light passes as a band

Zach chose this: on November 5 he compared two lights for the working line in the design pass's prototype `sotto-council/prototypes/light-band/`, kept outside the repository, and picked B (`c8290a063`). A was his October 25 light as it stood: a band that was a share of the line's width with straight edges, drawn over the muted words. Reviewers read a still frame of it as a highlighting bug, since on a long line it lit whole words at full strength ("Read" alone lit in "Read the request policy", "Wai" in "Waiting for your permission") and the lit letters, drawn twice, looked bold.

**The band.** The light is a band about ten letters wide (10.5em) whatever the line's length, with a soft core at full strength and long eased edges, slanted, so in any one frame letters brighten towards the middle and fade on both sides.

**Drawn once.** The muted words fade out where the lit copy fades in, so a lit letter is drawn once, in the light, and keeps the words' weight.

**What stays.** The colour is `--tt-working-light` as the October 25 amendment has it, the cycle is the same 4.2 seconds with the crossing in 72% of it and then a rest, and there is no halo. Reduced motion and **Last seen working** are unchanged.

**What it costs.** The band crosses the line and its own width in the same time, where A's crossed twice the line's width, so on a long line it moves more slowly than before.

## November 5, 2026 amendment: the open steps name the running step

Zach chose this: on November 5 he compared two answers for the working line while a running turn's steps are open, in the design pass's prototype `sotto-council/prototypes/line-open/`, kept outside the repository, and picked B (`d5caf931a`). A was the line as his November 4 and November 5 picks left it, naming the running step whether its steps were open or folded, so with them open the step was said twice, on the line and on the newest row under it.

**Open.** While the steps are open, the line carries the Spaceballs words with the light, at once on the press, and the running step is named once, on its row, the newest of them. A request waiting on the user ("Waiting for your permission") and "Writing a reply" stay on the line, since they have no row.

**Folded.** Folding the steps brings the step back to the line at once, as the November 4 and November 5 amendments have it.

**What stays.** The button keeps its name, and its description still reads the step, the command included. The line is still the turn's one line, and the newest six rows show with **Show earlier** for the rest.

## November 6, 2026 amendment: the command shows on demand

Zach chose this: on November 6 he compared three answers for the rows of a turn's opened steps, in the design pass's prototype `sotto-council/prototypes/steps-open/`, kept outside the repository, and picked C, "command on demand". A was the rows as they stood: what the step was for, with its command under or beside it in the code face a size smaller, both in the second ink. B was what the step was for in the body's ink and weight, with the command under it a size smaller and muted. Reviewers had read A as two lines of near-equal small grey, so a long list of steps blurred into one block and the commands repeated what their purposes said.

**The rows.** When the provider said what a command was for, as Claude Code does for each one, its row says that alone, as Claude's own summaries do. The command shows only once the row is opened: under what it was for, whole, in the code face with Copy at the end of its line, then what it printed. This holds wherever opened steps are drawn: under the working line, in a finished turn's **Worked for** fold, beside Watcher and in Watcher's own conversation.

**Still there.** A folded row's command is still in its button's name, so a screen reader hears what it was for and then the command, and it is the row's tooltip. A command with no description, as Codex sends them, still names itself by its command, cut where it says least.

**What stays.** The working line, its light and its words, the plan's checklist above it, the Spaceballs words while the steps are open, and the newest six rows with **Show earlier** for the rest are unchanged.

**What it costs.** Reading which command ran takes a press, or a pointer resting on the row.

## November 6, 2026 amendment: quiet turns

Zach chose this: on November 6 he compared three answers for the rhythm of a long thread of short exchanges in the design pass's prototype `sotto-council/prototypes/turn-rhythm/`, kept outside the repository, and picked C, "quiet turns". A was the thread as it stood: a hairline across the column before each message the user sent after the first, in the space kept before it (`84039c5d1`), and every turn's **Worked for** line in view. B was tight gaps with no rules: no hairline, and the space before a sent message cut to the reply's copy room and 6 px more, so the bubble alone marked where a turn started. Reviewers had said the gaps wasted room on short exchanges, that faint hairlines made a reply's end hard to find, and that a full-width rule plus "Worked for 3.0s · 1 step" on a trivial reply was chrome without information.

**No rule between turns.** The hairline goes. The space between turns stays as it was, and the bubble, with You and the time on it, says where a turn starts.

**A quick turn's line.** A finished turn that took under fifteen seconds with one step or none keeps its closed **Worked for** line's room but shows nothing there, so nothing moves when it comes and goes. It comes back while the pointer is over the turn: its message, the line itself or the reply under it. It comes back while the keyboard is on it: the line is still a button in the tab order, the stop after the message's copy control, so Tab reaches it and it shows with its focus ring. Its name is unchanged, so a screen reader reads it as before, and a press opens it as before; an open line stays in view. What the turn changed still shows beside it ("Edited control.ts +12 −4"). The line fades in and out over 120 ms, and comes and goes at once under reduced motion.

**Which turns.** The time and the count are the ones the line says. A turn that failed or was stopped keeps its line, since that line says how the turn ended. A turn that delegated work keeps its line, since the work is another thread's and may still be going; the prototype had no such turn, so this was worked out rather than shown. A turn that only thought for a moment but took more than one step keeps the muted line it had.

**Where.** Desktop threads, threads beside Watcher, and Watcher's own conversation, which draws its turns the same way and never had the hairline. In Watcher's conversation the closed line keeps a rule under it, and that rule comes and goes with the line. Watcher's answers to news fold their work into the answer's header and have no line to hide.

**What stays.** You and the time on every sent message, the bubble ending at its words with its copy control under its corner, the 16 px text, the gaps, and the working line.

**What it costs.** A quick turn's time and step count are a pointer or a Tab away rather than in view, and a reader can no longer see at a glance that such a turn ran a step.
