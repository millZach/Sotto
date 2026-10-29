# The quiet composer is one pill

## Status

Accepted October 29, 2026, by Drake Morey's choices. An Owl feature (`quiet-composer`, ADR-0072); Drake chose Owl. **Number provisional until merge** (docs/agents/domain.md).

Amends, in a thread's composer and only while the feature is on: [ADR-0110](0110-containers-are-filled-cards-and-no-control-is-a-pill.md) (the composer is a pill), [ADR-0113](0113-the-composer-controls-are-text-buttons.md) decisions 1 to 3 (its options and actions), and [ADR-0153](0153-the-composers-buttons-are-its-keys.md) decisions 1, 2, 4 and 5 (its buttons, their key caps and the light round Stop). Answers, continuations, Watcher's composer and every composer with the feature off keep those decisions as they are.

## Context

On October 28 and 29, 2026, Drake asked for the Threads composer to be redesigned, with Claude Code's composer as the one reference, and worked through six rounds of prototypes:

- twenty structural directions (`prototype/composer-redesign-20`);
- the island that opens (`prototype/composer-island-refine`);
- twenty minimal, live directions (`prototype/composer-minimal-20`);
- twenty quiet composers with effort drawn rather than written (`prototype/composer-quiet-20`);
- the thinking-dots refinements (`prototype/composer-dots-refine`);
- ten ways the dots could answer the prompt and the chat (`prototype/composer-dots-alive`), then the suggested effort (`prototype/composer-dots-suggest`) and the actions (`prototype/composer-pill-actions`).

His notes along the way set the brief: the composer was "still too crowded"; effort should be shown "in a diff direction than words"; the model stays; full access is a shield; "ways to reduce noise of the prompt box". He picked 10.2 (the provider's mark and the model, effort as dots in the provider's colour), C as drawn (dots a draft seems to want ring, with a short note) and P4 (the dots stop the turn).

## Decision

**1. One pill.** With the feature on, a thread's composer is one rounded line: attach, the prompt, the provider's mark and the model's name, the effort dots, the permissions shield and one round disc. It grows with the prompt. Review comments, quotes and attachments keep their rows above and below the line.

**2. Effort is dots.** One dot per level the model offers, lit up to the level set, in the provider's colour drawn toward the text so it reads on either theme. The dots are one slider: a press on a dot or an arrow key sets that level through the same save as the effort card, with the same refusals and notices. The effort card, with its Ultrathink button and its note about ultracode, is not reached from the pill.

**3. The draft may suggest more effort; only a press changes it.** The window reads the draft's own words: a long draft, several lines, and words such as refactor, debug, why or investigate. When they suggest a level above the one set, those dots ring and a short note says so for a moment ("Suggests High. Press a ringed dot to use it."). Nothing leaves the computer for it, and nothing changes until the user presses a dot (ADR-0004). Nothing is suggested while a turn runs.

**4. Permissions are their shield.** The permissions control shows only its shield at every width, the words kept for assistive technology and its tooltip, as ADR-0113 decision 2 already does in a narrow pane. Full access, the one mode that asks about nothing, fills the shield in the warning colour.

**5. One disc.** It is Send. While a turn runs and something is typed it is Queue, with a glyph of an arrow into a tray. While Steer's modifier is held (Cmd on a Mac, Ctrl elsewhere) it is Steer, in the accent. Enter, Cmd+Enter (Ctrl+Enter) and Cmd+Shift+S (Ctrl+Shift+S) do what they did; the keys live in each control's name, tooltip and `aria-keyshortcuts` instead of key caps.

**6. The dots stop the turn.** While a turn runs, the lit dots bounce, one after another, and that is the sign that it runs, in place of the light round Stop. The dots then hold Stop: pointing at them or reaching them with Tab shows a Stop button over them, named as Stop is named today. Where a provider cannot change a started thread and so draws no dots, Stop keeps a small button of its own in the pill.

**7. Less in the line.** Fast mode keeps its bolt. Watch on send is not drawn; Watch stays in the pane header. The model's chevron and the key caps go. The branch toolbar and the queue stay where they are, under and over the pill.

**8. Motion.** The suggested rings pulse and the dots bounce on `transform` alone, pause while the window is hidden, and stop with reduced motion, the system's or Sotto's own.

## Consequences

- Stable is unchanged; on Owl the Threads composer is the pill.
- The effort card's Ultrathink button and ultracode note are not offered from the pill. Typing "ultrathink" still asks Claude Code for it.
- Stop has no visible button while a turn runs until the dots are pointed at or reached; Cmd+Shift+S and the queue's own controls are unchanged.
- The suggestion is a guess read from words. It never changes a setting, and it never asks for less than the user chose.

## Considered options

- **Every other prototype round.** Drake turned down the twenty structural directions, the island, and the twenty minimal directions as too alike and too crowded. Within the final rounds he chose C over the still, ghosted, reasoned and on-Send suggestions, and P4 over a disc with Steer and Stop stepping out, a Next/Now switch, words while a turn runs, and one disc with a key card.
- **Moving the branch toolbar into the pane header.** Left for its own change: it is ADR-0027's, and it carries the run target, the workspace and the pull request as well as the branch.
- **Hiding attach.** Drake's pick drew no attach. It stays, as the first thing in the pill, so attaching any file (ADR-0131) keeps a control a keyboard and a pointer can reach.
