# Zach's composer is the only composer, and its effort word offers a level

## Status

Accepted October 31, 2026, by Drake Morey's choices: remove Drake's composer and the Appearance choice; draw Zach's composer wherever a composer is drawn, answers, continuations and Watcher's handover included; and pick A, "The word moves", of `docs/prototypes/effort-suggestion-prototype.html` for how the composer offers more effort. **Number provisional until merge** (docs/agents/domain.md).

Amends [ADR-0168](0168-zachs-composer-is-two-rows-and-drakes-pill-is-the-other-style.md) decision 1 (there is one style, and no choice in Appearance) and the line in its decision 1 that kept the full composer for answers, continuations and Watcher's handover. Amends [ADR-0161](0161-the-quiet-composer-is-one-pill.md): the pill is gone, and decision 3's short note gives way to the offer below.

## Context

On October 30, 2026, Zach picked a two-row composer for himself and asked for Drake's pill to stay as an option, since Drake had made it (ADR-0168). The two lived side by side under **Composer** in Settings › Appearance. On October 31 Drake asked for his pill to go, and with it the Appearance choice, so that every composer is Zach's.

Three places still drew something else. Watcher's first-start composer set the quiet composer's mark without a style, so it drew Drake's pill whatever was chosen. Answering a question, a continuation and Watcher's handover switched to the full composer of ADR-0113, with key caps and text buttons.

Drake also said the effort suggestion did not always appear, and that it should be more apparent and look finished. Two things kept it out of sight. The draft's score was spread across every level the model offers, so with Medium set most drafts never reached a level above it. When one did, a note floated over the prompt for 2.4 seconds and went; after that only a mark inside the closed effort list said anything.

Next prompt suggestions (ADR-0132) were checked at the same time, since Drake thought the ghost had gone from Zach's composer. It had not: his screen on October 31 shows the ghost and its Tab key in Zach's composer on finished Codex and OpenCode threads. It is offered only for threads on this computer, after a turn that ends with a reply, and not while a question waits, during a continuation or after Watcher answers Sotto's own news; a restart clears what main holds until the next turn ends. Nothing about it changes here.

## Decision

**1. One composer.** Zach's composer (ADR-0168 decisions 2 to 6) is the composer everywhere one is drawn: a thread, Watcher, Watcher's first start, an answer, a continuation and Watcher's handover. The `composerStyle` setting and the **Composer** choice in Settings › Appearance are gone; a settings file that still carries the key loads as before and drops it. The layout lives in `quietComposer.css`.

**2. An answer, a continuation and the handover keep their own action in the disc.** The disc keeps the Send glyph and takes the action's name and keys: Send answer, Continue on Codex (or whichever provider), or Watcher's handover label. The continuation's strip and the handover's offer above the card still say what a send does. While a turn runs with nothing typed, the disc is Stop, as it is for a prompt. A continuation's options draw as the footer's words too: its permissions before the model, and its effort as the same word with the same offer.

**3. The draft's score is measured from the model's default.** The window reads the draft's own words: the kinds of hard work it names (such as debug, refactor, why, investigate, migrate, regression, performance, security, broken or not working; each kind counted once, up to three), three or more lines, and more than 140 characters. A draft with one of those suggests one level above the model's own default; one with three or more suggests two. Where the model names no default, it is measured from the level set, and nothing is suggested on the provider's default, since Sotto cannot tell what that runs at. It suggests only a level above the one set, never less than the user chose, never Ultracode (a way of working, not more thought, ADR-0148), and nothing while a turn runs or the setting cannot change. Nothing leaves the computer for it.

**4. The effort word offers the level until it is taken or no longer called for.** After the effort word stand a muted arrow and the suggested level in the accent on its wash: "Medium → High". The level's wash is thinner than the accent's usual wash so its text holds 4.5:1 in every theme. That level is one press that sets it, through the same save as the effort list (ADR-0004: only a press changes anything). Its name is "Set effort to High, suggested for this draft". Once pressed it goes: a pointer press returns focus to the prompt, and a key press leaves it on the effort word. It rises in once over 180 ms and is still after; with reduced motion it simply appears. In a right-to-left interface the arrow turns to point at the level. The level, and only that level, is marked "Suggested for this draft" in the effort list, and assistive technology hears "High effort suggested for this draft." when it arrives.

## Consequences

- Nobody can switch back to the pill. A user who had chosen Drake's composer sees Zach's on the next start.
- The full composer of ADR-0113 and ADR-0153 is drawn only while the `quiet-composer` gate is off, which no build does now that it is on stable.
- The branch toolbar sits in the pane header while a question waits too, instead of moving under the composer for the answer.
- Words that ask for hard work offer more effort more often than before. The offer can be ignored; it never changes a setting by itself, and it goes once the draft no longer calls for it.

## Considered options

- **B, a button before the model** ("✦ Try High ×"), with a way to put it away for the draft. More visible, and one more thing at the footer's start.
- **C, a line inside the card** that says why ("High effort may suit this draft · it says 'debug'") with Use High and Not now. The most apparent and the only one that explains itself; it adds a row to the card while it stands.
- **Keeping the full composer for answers, continuations and the handover**, as ADR-0168 had it. Drake chose one layout everywhere.
