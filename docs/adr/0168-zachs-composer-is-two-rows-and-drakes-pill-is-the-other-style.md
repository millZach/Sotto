# Zach's composer is two rows, and Drake's pill is the other style

## Status

Accepted October 30, 2026, by Zach's pick A of `prototype/composer-zach` (`docs/prototypes/composer-zach-prototype.html`), with his change "add lightning bolt next to effort for models that can use it". Sent straight to stable by his choice the same day, which sends the quiet composer of [ADR-0161](0161-the-quiet-composer-is-one-pill.md) to stable with it. **Number provisional until merge** (docs/agents/domain.md).

Amends ADR-0161: the quiet composer is now one of two styles of the same parts, and no longer an Owl-only feature.

Amended October 31, 2026, by [ADR-0172](0172-zachs-composer-is-the-only-composer-and-its-effort-word-offers-a-level.md): at Drake's request, Drake's composer and the Appearance choice are gone, and Zach's composer is drawn wherever a composer is, answers, continuations and Watcher's handover included. Decisions 2 to 6 stand.

## Context

Drake redesigned the thread composer as one quiet pill over six rounds of prototypes (ADR-0161). On October 30, 2026, Zach said he did not like it for himself: too much shares its one row (attach, the shield, the prompt, the split chip, Stop and the disc), and he did not like its look. Drake made that composer, so Zach asked for it to stay as an option.

He named three references: the Claude Code desktop app, Codex and T3 Code. Their composers were read from primary sources (vendor docs and footage, T3 Code's source); the findings and what could not be checked are on the prototype page. All three put the prompt on a row of its own and the settings in a line under it. T3 Code keeps that line quiet: attach on the left; the model and its effort as plain words on the right; then a round Send.

Four directions went to Zach beside Drake's pill: A after T3 Code, B after Codex (permissions in words on the left, a Faster-to-Smarter slider, a queue tray), C after Claude Code desktop (settings outside the card, no disc) and D (everything behind one button). He picked A.

## Decision

**1. The composer has two styles, chosen in Settings › Appearance.** **Zach's composer** is the default; **Drake's composer** is the pill of ADR-0161, kept whole. The choice is the `composerStyle` setting (`rows` or `pill`), offered as two cards with a sketch of each under **Composer** in Appearance's Details. It applies to the thread and Watcher composers alike. Answers, continuations and Watcher's handover keep the full composer in either style, as ADR-0161 has them.

**2. Zach's composer is two rows.** The prompt has the card's whole width on the first row. Under it, attach sits on the left. At the far right sit the permissions, then the model and its effort as words, then the disc. Nothing in the footer is a filled chip: the split chip's parts and menus are kept, without its fill and hairline. Review comments, quotes and attachments keep their rows above and below the prompt.

**3. The bolt is drawn wherever the model offers a speed.** After the effort word comes the split chip's bolt: an outline at Standard, one bolt at Fast, two at Ultra fast. A model with one speed draws none. The menus, keys, suggestion and saves are the split chip's (ADR-0161 decision 2).

**4. Permissions are always shown, before the model.** They show as the shield and the mode's name, in the mode's colour (muted for Ask first, the accent for Automatic and Allow edits, gold for Full access). In a pane 560 pixels wide or less, only the shield shows; the name stays in its tooltip and for assistive technology. They come first in the DOM, so Tab takes them in the order they are drawn. The prototype hid them at "your default", as T3 Code does; Sotto has no user-wide default permission mode to compare with, so they are always shown.

**5. One disc, and Stop drawn once.** The disc is Send, Queue while a turn runs and something is typed, and Steer while Steer's modifier is held, as in the pill. While a turn runs with nothing typed, the disc is Stop, with the same name, keys and tooltip as Stop. Once something is typed it becomes Queue, and a small Stop stands beside it. The prototype's "Working 48s" line above the card was not built: the transcript's live turn already says that the thread is working.

**6. No edge.** The card is filled and has no border or outline in any state, as ADR-0110 has it. Only the top-effort trace (ADR-0019) may run along its edge.

**7. Straight to stable.** Both styles and the choice ship on stable. The `quiet-composer` entry in `src/shared/owlFeatures.ts` is sent to stable (`sentToStable: true`), so the stable thread composer is one of these two styles and no longer the full composer of ADR-0113. The slim composer, the branch controls in the pane header and everything else ADR-0161 moved stays with both styles.

## Consequences

- A stable user who has never chosen sees Zach's composer. Drake's pill is one press away and keeps every behaviour ADR-0161 gives it.
- The full composer of ADR-0113 and ADR-0153 is left for answers, continuations and Watcher's handover.
- Two layouts of one set of parts: a change to the parts (the disc, the split chip's menus, Stop) reaches both, and each style's layout lives in its own stylesheet (`rowsComposer.css`, `quietComposer.css`).

## Considered options

- **B, after Codex.** Permissions always on the left in words, model and effort behind a slider, queued messages on a tray. Close to A; Zach chose A.
- **C, after Claude Code desktop.** Settings on the pane under a card that holds only the words and a return key. It drops the disc.
- **D, one button.** Everything behind one control. Fewest things in sight, but every setting is one press further away.
- **Keeping the pill and changing its look.** Zach asked for options and for Drake's composer to stay as it is.
