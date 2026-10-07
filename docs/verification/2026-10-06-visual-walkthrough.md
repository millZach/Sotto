# A visual's walkthrough: verification

October 7, 2026. Issue #793, on `feat/visual-walkthrough` from `feat/visualize-tool`. The decision is ADR-0056; the
glossary term is **Visual**. The layout is variant C of `prototype/visualize-layout`, the walkthrough Zach picked.

## How it was run

`tests/e2e/visual-walkthrough.spec.ts` launches the built app on Windows 11 against the end-to-end provider fixture,
gives the Workshop thread a prompt and a reply, and calls the visualize tool five times through the end-to-end channel
the #792 spec uses: a flowchart, a sequence diagram, a state diagram, a class diagram and an entity relationship
diagram, each with steps that name parts of it. It steps through them with the mouse and the keyboard and reads the
lit parts out of the picture the renderer made: the SVG inside each `<img>` is decoded and its marked parts listed by
the ids Mermaid gave them. Every capture below is from that run, at a display scale of 150 percent.

The lighting itself is unit tested on what Mermaid 11.17.2 really draws: `tests/fixtures/mermaidSteps/` holds one
drawing of each kind, a sequence diagram with numbered arrows and an activation bar, one with aliased participants
and a flowchart with a subgraph inside another, captured by `capture.mjs` in Chromium with the app's settings, and
`tests/unit/renderer/diagramSteps.test.ts` passes each through the app's sanitizer before lighting steps on it.

## What lights

- **Flowchart.** A node by its id. A subgraph by its id, with the nodes and subgraphs inside it. An edge written `A->B` (or
  `A-->B`) with its label and its two ends. An edge between two nodes a step names lights too, but the ends of a named
  edge do not count, so naming `B->A` does not light `A->B`.
- **Sequence diagram.** A participant by its name, or by the words it is drawn with (`participant U as User` lights
  for U or User), with its lifeline and activation bars. An arrow by its number,
  counted from 1 down the drawing past loops, notes and alternatives (Mermaid's own ids count those rows too), with
  its words, its autonumber badge and its two participants. Notes and loop, alt and other boxes stay dimmed.
- **State diagram.** A state by its id; a composite state with the states inside it. Transitions never light:
  Mermaid's output does not say which states a transition joins.
- **Class and entity relationship diagrams.** A class or entity by its name, and the relation between two lit ones
  with its label. Multiplicity labels ("1", "many") stay dimmed.
- A name the drawing does not have is ignored, and a step whose names match nothing leaves the whole drawing lit.
- A visual with one step shows its words alone under the drawing, its part lit, with no count, dots, Back or Next.

## What the captures show

- `artifacts/visual-walkthrough/flowchart-step-1280x800-dark.png`: the first step. "Step 1 of 4", four dots with
  the first as a short bar, Back and Next, and the step's words in larger type. Draft is lit; the rest is dimmed.
- `flowchart-edge-1280x800-dark.png`: the second step, `B->C`. Ready?, Send and the "yes" edge between them are lit,
  in the theme's accent.
- `flowchart-expanded-1280x800-dark.png`: Expand, opened from the keyboard on that step, shows the same lighting.
- `flowchart-read-all-1280x800-dark.png`: after Read all. The walkthrough gives way to the intro and the four
  numbered steps, nothing is dimmed, and the button reads Step through.
- `flowchart-reduced-motion-1280x800-dark.png`: under reduced motion, the next step's picture in place at once.
- `sequence-step-1280x800-dark.png`: arrow 3, `turn/start` inside the loop, lit with Sotto and Codex.
- `flowchart-step-1600x1000-dark.png`, `flowchart-step-1600x1000-light.png`, `flowchart-step-1280x800-light.png`,
  `flowchart-step-820x560-dark.png` and `flowchart-step-820x560-light.png`: the second step at each size, redrawn in
  each appearance's colours.
- `sequence-step-820x560-dark.png` and `sequence-step-820x560-light.png`: the minimum window with the last step of the
  sequence diagram. Next reads Start over.

## What the spec asserts beyond the pictures

- Each kind lights the parts listed above, and every step's picture has the drawing's size.
- The keyboard path: Tab goes from Expand to the current step's dot, the dots' one Tab stop, then Back and Next, with
  a solid focus ring. On the dots, Right moves the step and the focus together; Enter on the third step's dot goes to
  step 3. Each dot is named for what a press does ("Go to step 3"), and the current one carries `aria-current`. Left and Right step while the
  focus is in the walkthrough and stop at the ends. Next on the last step reads Start over and goes back to step 1.
  Back on the first step stays focusable and does nothing. Read all sits before Show source in the header; Space
  shows every step and the button, still focused, reads Step through, and Space again goes back. Expand opens the viewer and Escape closes it with the focus back on Expand.
- Under reduced motion the card holds one picture after a step and nothing in it moves for longer than the app's
  1 ms floor. The cross-fade with motion is checked by `tests/unit/renderer/visualWalkthrough.test.tsx` on a
  fake clock, not here: it lasts 180 ms, too short to assert on without racing it.
- At 1600x1000, 1280x800 and 820x560, in light and dark, the flowchart and sequence cards are no wider than the window,
  and their header buttons, walkthrough buttons, picture and words are inside the card. The count, the step's words,
  Read all and the walkthrough's buttons measure at least 4.5:1 on the surface they sit on, and so do Back on step 1
  (a muted colour, not opacity), Step through, the intro and the numbered steps.
- No page errors were raised.

`tests/e2e/visuals.spec.ts` (#792) now opens its card as a walkthrough and presses Read all before checking the intro
and steps; they still show, under Step through, when the finished turn draws the card again by its fold. Its captures in
`artifacts/visual-in-thread/` were not taken again for this note.

## A real provider

On October 7, `tests/e2e/visuals-live.spec.ts`, run against this branch, had a real Claude Code thread draw "A request round trip" as a sequence diagram with three steps.
Claude named participants and arrow numbers on its own, and each step lit what it named: step 2 the Server and the
Database with the query and its answer ([live-claude-step-2-dark.png](../../artifacts/visual-walkthrough/live-claude-step-2-dark.png)),
step 3 the Browser and the Server with the last answer, with **Start over** in place of Next
([live-claude-step-3-dark.png](../../artifacts/visual-walkthrough/live-claude-step-3-dark.png)).
The run is repeatable from the committed spec: its prompt asks for a highlight list on every step, and its Claude run
steps to step 2, checks that something is lit and keeps `artifacts/visuals-live/claude/walkthrough-step-2.png`. The two
captures cited here were taken by hand from the run above, before the spec stepped through on its own; the spec has
not been run live since.

## Not verified here

- The dimmed parts are at 30 percent, a little stronger than the prototype's 22. Dimmed words in the drawing fall
  under 4.5:1 on purpose, the exception ADR-0056 records: they are de-emphasis while a step is shown, Read all and Show
  source show every word at full contrast, and the step's words and the controls, Back on step 1 included, measure
  4.5:1 or more. The lit labels were not measured.
- Codex and Grok Build were not asked to draw a walkthrough; both drew visuals with steps for #800.
- Diagram kinds and shapes beyond the five fixtures (flowchart shapes other than boxes and diamonds, sequence boxes and
  notes over participants, class namespaces) were not captured; unknown parts stay dimmed and never break a step.
