# A visual in its thread: verification

October 6, 2026. Issue #792, on `feat/visualize-tool`. The decision is ADR-0055; the glossary term is **Visual**. The
layout is variant C of `prototype/visualize-layout`, without its stepper, which is #793.

## How it was run

`tests/e2e/visuals.spec.ts` launches the built app on Windows 11 against the end-to-end provider fixture. It gives
the Workshop thread a prompt and the start of a reply, then calls the visualize tool through an end-to-end channel
that hands the call to the same `sotto_visual` server a provider's call reaches, under the thread's Sotto ID. The
spec then streams the rest of the reply, finishes the turn, and checks the card at three window sizes in both
appearances. It restarts the app on the same profile and gives the thread its history again. Every capture below
is from that run, at a display scale of 150 percent.

The fake providers were checked beneath the window too: `tests/integration/visualProviders.test.ts` has Codex,
Claude Code and Grok Build each call the endpoint they were given at launch, and the card lands after the reply
before the call and before the reply after it, including when the call comes in the middle of a reply.

## What the captures show

- `artifacts/visual-in-thread/card-1600x1000-dark.png` and `card-1600x1000-light.png`: the finished turn. Its work
  is folded under **Worked for**, the card stays in view under it, and the agent's last reply follows the card. The
  header carries the title, "Sequence diagram", Show source, Copy source and Expand; the intro and four numbered
  steps sit under the drawing.
- `card-1280x800-dark.png` and `card-1280x800-light.png`: the same at the common window size. The diagram is drawn
  again in each appearance's colours before the capture.
- `card-820x560-dark.png` and `card-820x560-light.png`: the minimum window. The title ends in an ellipsis and the
  three controls stay inside the card; the page does not scroll sideways.
- `expanded-1280x800-dark.png`: Expand, reached from the keyboard, opens the diagram viewer. Escape closes it and
  focus returns to Expand.
- `error-1280x800-dark.png`: a flowchart Mermaid cannot parse. The card shows "Couldn't draw this diagram. The source
  has a syntax error on line 3.", the source under it and its one step, still readable. There is no Show source or
  Expand, because there is no drawing.
- `restarted-1280x800-dark.png`: after the restart, the card is back in its place in the turn.

## What the spec asserts beyond the pictures

- The card arrives in the open thread without reopening it. While the turn runs, the text reads in order: the reply
  before the call, the card, the reply after it. Once the turn ends, the fold, the card and the final reply read in
  that order, and the card is not inside the fold.
- Show source, Copy source and Expand follow each other in the Tab order. A keyboard arrival draws a solid focus
  ring. Show source toggles `aria-pressed` and shows the Mermaid source.
- Under reduced motion (the spec emulates `prefers-reduced-motion: reduce`), the card draws the same diagram, and no
  element in it, or in the expanded viewer, has a transition or animation longer than the app's 1 ms reduced-motion
  floor, the viewer's backdrop included. Expand opens and Escape closes the viewer
  with focus back on Expand. There is no capture of it: the card has no motion of its own, so it looks as above.
- At each size and appearance, the card's title, kind, intro and steps measure at least 4.5:1 against the surface
  they sit on, composited over the room. The card is no wider than the window, and its controls are inside it.
- With **Let agents draw visuals in threads** off, the setting survives the save. A call is refused with "Visuals
  are turned off in Sotto's settings. Nothing was drawn. Explain in text instead.", and the visual already in the
  thread stays.
- The window's copy of the thread holds the visual's text, ending "The visual is in Sotto on your computer."
- No page errors were raised.

## Real providers

On October 6, `tests/e2e/visuals-live.spec.ts` ran the production app over an isolated profile with the real clients
on this computer (`SOTTO_VISUALS_LIVE=1`, one provider at a time). Each thread was asked for one sequence diagram
between two fixed sentences.

- **Claude Code** (its default model, Ask for approval): the visual message sat between "Here is the round trip." and "That
  is the whole trip.", and no request appeared ([live-claude-dark.png](../../artifacts/visual-in-thread/live-claude-dark.png)).
  With the setting turned off, the next call drew nothing and asked nothing. Turned back on, the next call drew, and
  that visual was there after a restart ([live-claude-restarted-dark.png](../../artifacts/visual-in-thread/live-claude-restarted-dark.png)).
- **Codex** (GPT-6.1-Sol): the first run found a real defect. Codex sent its steps as a list of sentences, the tool
  refused the call, and Codex went on without drawing. A step may now be a sentence; the rerun drew between the two
  sentences with no request ([live-codex-dark.png](../../artifacts/visual-in-thread/live-codex-dark.png)).
- **Grok Build** (Grok 4.7, Ask for approval): drew between the two sentences with no request in five of seven runs
  ([live-grok-dark.png](../../artifacts/visual-in-thread/live-grok-dark.png)). In the other two the model called
  `use_tool` with a name it guessed ("visualize", then "visual") instead of searching first. Grok asks before it
  resolves such a name, and Sotto answers that question only for a name tied to its own server, so Grok's prompt
  showed. The server's instructions now tell agents to search and use `sotto_visual__visualize`; of the five runs after
  that change, four searched first and drew with no prompt, and one guessed "visual". A guessed name still shows
  Grok's prompt, on purpose: Sotto cannot tell it from another server's tool of the same name.

## Not verified here

- The iPhone app was not run. The socket strips the `visual` field for every client, which
  `tests/integration/socketHost.test.ts` checks for a whole detail, a delta and a read.
- The packaged app was not run; the live runs used the built app from this branch.
