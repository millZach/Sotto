# The creature above the composer is a choice

## Status

Accepted October 22, 2026, at Drake Morey's request: a second creature, Claude bot, a switch for it in Settings → Appearance, and the readout's gray box gone. Builds on [ADR-0021](0021-waiting-reads-the-clock-not-a-watch.md), [ADR-0023](0023-working-reads-the-providers-agent-tasks.md) and [ADR-0061](0061-a-thread-can-babysit-its-pull-request.md), which decided the poses and what each one claims, and on [ADR-0084](0084-the-window-and-its-surfaces-are-always-solid.md), which makes the room solid. **Number provisional until merge** (docs/agents/domain.md).

He asked for the walking animation of the strip above the composer in a character of its own, "Claude bot", embellished and drawn to look good, and left its look to us.

## Context

The **creature** that stands on the composer's top edge has been one character since #125. Its poses (a watch, background work, a held action, babysitting) are decided and documented, and its readout sat in a tab: a `--tt-surface` fill and a `--tt-field-border` outline over the room. The fill hid whatever stood behind it, and the box read as a gray bar.

## Decision

**1. One setting, in stable.** `creature` is `sotto` or `claude`, saved with the other settings, `sotto` by default. It is not an Owl feature: it is a small change to a feature that is already in stable.

**2. Claude bot wears every pose.** Walking with a magnifying glass for a **monitoring task**, standing by the readout and sending small bots along the track for **background work**, holding the hourglass for a **held action** or a command left waiting, resting in the muted colour with a sign for **babysitting**. Which pose shows, when, and what it claims are exactly what ADR-0021, ADR-0023 and ADR-0061 decided; the choice is how Sotto looks, never what it says, and it grants nothing. Reduced motion holds it still as it holds Sotto's creature.

**3. Where it lives.** Settings → Appearance → **Creature**, after Effort color: each character walking in a frame of its own above its name. A choice saves at once, on this computer, and every thread pane follows it, a pose already showing included. It is a plain setting: it is not part of the appearance cache or the live preview, because it paints only inside thread panes. The iPhone and Android clients have no creature.

**4. Colour comes from tokens.** Claude bot's body is the provider's own fill for Claude (`--tt-provider-claude`) and its eyes and mouth the provider's ink (`--tt-provider-ink`), shaded by mixing them, so it follows the theme the way the provider marks do. Babysitting mutes it, as it mutes Sotto's creature. Its antenna bulb is the theme's activity colour, the one Sotto's creature wears. The stylesheet holds no colour literal.

**5. Sotto's creature does not change.** Every pose was rendered before and after, in both themes, on a wide and a narrow track and in the reduced-motion stance, and the pixels of the creature are the same.

**6. The readout is words on the room.** No fill and no outline, for both creatures, so it can never cover what it stands over. The room is solid (ADR-0084), so the words keep the contrast the theme gives text.

**7. Show the creature, in Owl (amended October 23, 2026).** At Drake Morey's request, Settings → Appearance → Creature has a switch, **Show the creature**, saved as `showCreature`, on by default. Off, no pose and no readout stand above any composer, and the character choice hides until it is back on; the sidebar still says what each thread is doing, so nothing the user needs to answer goes unseen. Unlike the character choice, the switch is a new feature rather than a change to one already in stable, so it is the Owl feature `creature-toggle` (ADR-0072): where it is held, the switch is not shown, Find a setting does not list it, and the creature shows whatever was saved, so a saved `false` stays whole for a build that has it. Only the renderer reads it; main starts nothing for it.

**8. Lardo, in Owl (amended October 28, 2026).** At Zach's request, in honour of his brother, a third character: **Lardo**, a tiny stage bodybuilder, tanned, in posing trunks, drawn as pixel art on the same 40 × 32 grid. `creature` may be `lardo`. He is the Owl feature `lardo-creature` (ADR-0072): where it is held, Settings does not offer him and a saved `lardo` shows Sotto's creature and stays saved. Zach picked the details from `docs/prototypes/lardo-creature-prototype.html` on October 28:

- **A classic pose for each pose.** Monitoring: he struts the track on the schedule Sotto's creature walks it and hits a side chest at each end. Working: front double biceps by the readout, pumping, while small Lardos jog out, one per agent. Held, and a command left waiting: the vacuum beside an hourglass on the floor. Babysitting: abdominal and thigh beside the pull request sign, still. What each pose claims, and when it shows, are unchanged; the creature never shows while a thread thinks, writes, is done or has an error, so those have no pose.
- **Babysitting keeps his colours.** Unlike the other two creatures (point 2), Lardo is not muted while babysitting; the sign and his stillness say it.
- **A flex when a turn finishes.** When the thread's turn ends while he is already standing above the composer, he turns, holds a back double biceps for about a second with a sparkle, and turns back. He never appears just to flex, so the composer and the transcript never move for it.
- **The easter egg.** Clicked, he rips a bite out of the composer's top edge beside him, lifts it, hurls it at the screen, where it shatters, and stands most muscular, flushed and steaming, while the composer grows back over the bite in about a second. The bite is 56 × 10 px, inside the composer's top padding, so it never covers what is written. Everything thrown is drawn over the window and catches no pointer; the composer's text, caret, attachments and focus are never touched, typing works throughout, and a press on him never takes focus. The composer keeps no border or outline. He answers a click on his own pixels only, so the room around him still lets the transcript under it be selected.
- **Mouse only.** He is not in the tab order and adds no control: a tab stop above every composer for an easter egg would cost every keyboard user on every thread. This is the one thing in the app a keyboard cannot do, and it does nothing anyone needs.
- **Reduced motion**, the system's or Sotto's own: every pose holds still, the flex is the back pose held for a moment, and a click shows the angry pose with nothing thrown.
- **Colour from tokens.** His skin is the provider fill for Claude (`--tt-provider-claude`, a tan in both modes), his ink the provider ink, his trunks the theme accent, his flush the error colour, his sparkle the activity colour. Watcher's composer is glass over the night scene; the bite is painted in the room's colour there too, and nothing he does repaints the scene.

## Considered options

- **A creature per provider or per thread.** Claude bot only on Claude Code threads. Rejected: the poses are not tied to one provider, a held action shows on Codex, Grok Build and Devin threads alike, and the creature says nothing about who runs the thread. Which one stands above the composer is the user's choice of look.
- **Only the walking animation.** Claude bot walking in every state. Rejected: each pose carries its glossary meaning, and the hourglass and the sign are how a reader tells Waiting and Babysitting from Monitoring and Working.
- **Keep the tab, drop its fill.** Leaves a gray outline with nothing in it. Rejected: the bar was the complaint.
- **A switch in Owl first.** Rejected: nothing about it needs to be held back.

## Consequences

A settings file without `creature` reads as Sotto, and an older Sotto reading a file written by this one drops the key. The Appearance page is one section taller, so its Windows design baselines need regenerating on a Windows machine; this change did not regenerate them. The readout's contrast is measured against the room it stands on rather than its own fill, in the end-to-end checks and in the verification note. Claude bot is drawn as rows of letters in `claudeBotSprite.tsx`, one unit per grid cell on the same 40 × 32 grid as Sotto's creature, so a future character is a new sprite and four poses, not a new layout. Lardo proved it: `lardoSprite.ts` holds his frames as rows of letters and `Lardo.tsx` wears all four poses on the other creatures' schedule, which `claudeBotParity.test.tsx` holds all three to.
