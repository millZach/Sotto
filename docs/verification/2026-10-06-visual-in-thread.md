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
before the call and before the reply after it.

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
- At each size and appearance, the card's title, kind, intro and steps measure at least 4.5:1 against the surface
  they sit on, composited over the room. The card is no wider than the window, and its controls are inside it.
- With **Let agents draw visuals in threads** off, the setting survives the save. A call is refused with "Visuals
  are turned off in Sotto's settings. Nothing was drawn. Explain in text instead.", and the visual already in the
  thread stays.
- The window's copy of the thread holds the visual's text, ending "The visual is in Sotto on your computer."
- No page errors were raised.

## Not verified here

- The iPhone app was not run. The socket strips the `visual` field for every client, which
  `tests/integration/socketHost.test.ts` checks for a whole detail, a delta and a read.
- No real provider was asked to draw. The fake providers stand in for Claude Code, Codex and Grok Build, as they do
  for the browser and host setup tools.
