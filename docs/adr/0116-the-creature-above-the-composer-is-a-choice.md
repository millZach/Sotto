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

## Considered options

- **A creature per provider or per thread.** Claude bot only on Claude Code threads. Rejected: the poses are not tied to one provider, a held action shows on Codex, Grok Build and Devin threads alike, and the creature says nothing about who runs the thread. Which one stands above the composer is the user's choice of look.
- **Only the walking animation.** Claude bot walking in every state. Rejected: each pose carries its glossary meaning, and the hourglass and the sign are how a reader tells Waiting and Babysitting from Monitoring and Working.
- **Keep the tab, drop its fill.** Leaves a gray outline with nothing in it. Rejected: the bar was the complaint.
- **A switch in Owl first.** Rejected: nothing about it needs to be held back.

## Consequences

A settings file without `creature` reads as Sotto, and an older Sotto reading a file written by this one drops the key. The Appearance page is one section taller, so its Windows design baselines need regenerating on a Windows machine; this change did not regenerate them. The readout's contrast is measured against the room it stands on rather than its own fill, in the end-to-end checks and in the verification note. Claude bot is drawn as rows of letters in `claudeBotSprite.tsx`, one unit per grid cell on the same 40 × 32 grid as Sotto's creature, so a future character is a new sprite and four poses, not a new layout.
