# The quiet composer is one pill

## Status

Accepted October 29, 2026, by Drake Morey's choices. An Owl feature (`quiet-composer`, ADR-0072); Drake chose Owl. **Number provisional until merge** (docs/agents/domain.md).

Amends, in a thread's composer and only while the feature is on: [ADR-0110](0110-containers-are-filled-cards-and-no-control-is-a-pill.md) (the composer is a pill, and its send is a round disc where decision 2 keeps round for status), [ADR-0125](0125-the-composer-slims-while-the-user-reads-back.md) (the slim line's Stop, decision 1), [ADR-0113](0113-the-composer-controls-are-text-buttons.md) decisions 1 to 3 (its options and actions), and [ADR-0153](0153-the-composers-buttons-are-its-keys.md) decisions 1, 2, 4 and 5 (its buttons, their key caps and the light round Stop). Answers, continuations, Watcher's handover and every composer with the feature off keep those decisions as they are. Amended October 29 after Drake tried Owl `.5`: Watcher shares the pill, speed moves into still effort dots, and the branch controls move to the pane header. Amended October 30 by Drake's pick 11c of `prototype/composer-effort-20` (`docs/prototypes/composer-effort-20-prototype.html`): the dots and their row under the model's name give way to the **split chip**, and the shield moves to the pill's start. Amended October 30 by [ADR-0168](0168-zachs-composer-is-two-rows-and-drakes-pill-is-the-other-style.md): the pill is now **Drake's composer**, one of two styles chosen in Settings › Appearance beside Zach's two-row composer, which is the default; and the feature is sent to stable.

## Context

On October 28 and 29, 2026, Drake asked for the Threads composer to be redesigned, with Claude Code's composer as the one reference, and worked through six rounds of prototypes:

- twenty structural directions (`prototype/composer-redesign-20`);
- the island that opens (`prototype/composer-island-refine`);
- twenty minimal, live directions (`prototype/composer-minimal-20`);
- twenty quiet composers with effort drawn rather than written (`prototype/composer-quiet-20`);
- the thinking-dots refinements (`prototype/composer-dots-refine`);
- ten ways the dots could answer the prompt and the chat (`prototype/composer-dots-alive`), then the suggested effort (`prototype/composer-dots-suggest`) and the actions (`prototype/composer-pill-actions`);
- after living with the dots on Owl, twenty directions without them (`prototype/composer-effort-20`), on October 29 and 30.

His notes along the way set the brief: the composer was "still too crowded"; effort should be shown "in a diff direction than words"; the model stays; full access is a shield; "ways to reduce noise of the prompt box". He picked 10.2 (the provider's mark and the model, effort as dots in the provider's colour), C as drawn (dots a draft seems to want ring, with a short note) and P4 (the dots stop the turn). Then, on October 29: "im not a fan of the dots under neath nor the dots themselves really". The twenty directions that followed found the dots hard to read (you count them), hard to discover (nothing said they could be pressed, and speed hid behind the lit dot), small targets (9 by 10 pixels), and speed told by colour alone. He asked for 11, the split chip, with the shield on the left, and picked 11c of three placements.

## Decision

**1. One pill.** With the feature on, a thread's or Watcher's composer is one rounded line: attach, the permissions shield, the prompt, the split chip and one round disc. Everything sits on the pill's one line; nothing sits under the model's name. It grows with the prompt. Review comments, quotes and attachments keep their rows above and below the line.

**2. Effort and speed are the split chip** (amended October 30; the dots are gone). One filled chip, 28px, with a hairline between its halves: the provider's mark and the model's name, which open the model menu, then the effort level in words, which opens a short list above it of the levels the model offers and, below them, its speeds. Speed is a bolt after the word where the model offers more than Standard: an outline at Standard, one bolt at Fast, two at Ultra fast. It is told by shape, not colour: no purple and no glow, and the provider's colour stays on its mark. A model with one speed draws no bolt and lists no speeds. With the effort half focused, the arrow keys, Home and End step the level, and Option+Up and Option+Down (Alt on Windows and Linux) step the speed, as the dots did. Each choice goes through the same save as the effort card, with the same refusals and notices. Its tooltip names the level and speed, and each speed in the list keeps the provider's words for what it costs. Orchestrating and Watcher's own effort and speed remain one choice in two places (ADR-0091 decision 5). The effort card, with its Ultrathink button and its note about ultracode, is not reached from the pill.

**3. The draft may suggest more effort; only a press changes it.** The window reads the draft's own words: a long draft, a draft of more than one line, and words such as refactor, debug, why or investigate. When they suggest a level above the one set (or, on the provider's default, above the model's own default), those levels say "Suggested for this draft" in the effort list and a short note says so for a moment ("Suggests High. Choose it from the effort list."). Nothing leaves the computer for it, and nothing changes until the user chooses a level (ADR-0004). Nothing is suggested while a turn runs.

**4. Permissions are their shield, at the pill's start.** The shield stands after attach and before the prompt (amended October 30), so who the message may touch is seen before it is typed. It shows only its shield at every width, the words kept for assistive technology and its tooltip, as ADR-0113 decision 2 already does in a narrow pane. Ask first is a muted outline, Automatic and Allow edits use the accent outline, and Full access, the one mode that asks about nothing, is gold with a slow moving sheen. Its tooltip names the selected mode. The sheen stops with reduced motion.

**5. One disc.** It is Send. While a turn runs and something is typed it is Queue, with a glyph of an arrow into a tray. While Steer's modifier is held (Cmd on a Mac, Ctrl elsewhere) it is Steer, in the accent. Enter, Cmd+Enter (Ctrl+Enter) and Cmd+Shift+S (Ctrl+Shift+S) do what they did; the keys live in each control's name, tooltip and `aria-keyshortcuts` instead of key caps.

**6. Stop stays small and visible.** The split chip stays still while a turn runs. A small Stop sits after the split chip and before Send, named as Stop is named today. Watcher's New Watcher control sits between the split chip and Stop: the chip, New Watcher, Stop when shown, then Send. It keeps its name and tooltip as a glyph in the quiet pill. Stop stays reachable where a provider cannot change a started thread and in the slim composer, which hides the split chip and the shield.

**7. Less in the line.** Speed lives in the split chip's bolt, not in a control of its own (ADR-0143). The provider's descriptions stay in their tooltips. Watch on send is not drawn; Watch stays in the pane header. The model's chevron and the key caps go. The delegation Stop note and the machine/workspace/branch line under the pill go. The existing workspace and branch controls stay reachable in the pane header beside the folder (ADR-0027); their behavior and shortcuts are unchanged. The queue stays above the pill.

**8. Motion.** The split chip and its suggestion have no animation at rest or while running; the note fades in and out. Only the Full access shield's slow gold sheen moves; it stops with reduced motion, the system's or Sotto's own.

## Consequences

- Stable is unchanged; on Owl the Threads and Watcher composers use the same pill, with controls each can change.
- The effort card's Ultrathink button and ultracode note are not offered from the pill. Typing "ultrathink" still asks Claude Code for it.
- Stop stays visible while a turn runs; Cmd+Shift+S and the queue's own controls are unchanged.
- The suggestion is a guess read from words. It never changes a setting, and it never asks for less than the user chose.

## Considered options

- **Every other prototype round.** Drake turned down the twenty structural directions, the island, and the twenty minimal directions as too alike and too crowded. Within the final rounds he chose C over the still, ghosted, reasoned and on-Send suggestions, and P4 over a disc with Steer and Stop stepping out, a Next/Now switch, words while a turn runs, and one disc with a key card.
- **Keeping the branch toolbar under the pill.** The first build kept it; after trying Owl `.5`, Drake asked to remove that line and keep its workspace and branch choices in the pane header.
- **The other nineteen directions without dots** (October 30), among them signal bars, a stepper, a ring around the provider's mark, the pill's top edge and the model's name as the meter, and three placements of the shield (inside the chip, just before it, at the pill's start). Drake chose 11c.
- **Hiding attach.** Drake's pick drew no attach. It stays, as the first thing in the pill, so attaching any file (ADR-0131) keeps a control a keyboard and a pointer can reach.
