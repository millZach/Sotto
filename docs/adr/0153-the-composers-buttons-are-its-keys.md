# The composer's buttons are its keys

## Status

Accepted October 27, 2026. Drake picked direction 9, Keys first, from ten in `docs/prototypes/prompt-send-stop-prototype.html`, kept at the tag `prototype/prompt-send-stop`, with the running motion of direction 8, and then 9b of three ways to carry it: the trace on Stop. It changes an existing control and fixes its contrast, so it goes straight to stable (AGENTS.md: fixes and small changes to an existing feature are not Owl features). It builds on ADR-0110 (controls are soft squares; the primary keeps its plate in the text colour) and ADR-0113 (Steer now beside Stop) and changes no rule of either.

## Context

The Threads composer ended in a 28px filled square: an arrow sent, a list-plus queued, a square stopped. Drake found four things wrong with it. Its glyph could vanish: the square was filled with `--tt-activity`, which is the accent *text* colour, and drew its glyph in `--tt-on-accent`, the colour made for the accent *fill*. Nothing paired the two. Sotto's own palettes happen to keep them apart, but T3 Chat's dark half sets both to the same pale pink (1.0:1), and every imported dark theme that leaves them out falls back to it. The words Steer now did a button's job beside two unrelated squares while a turn ran (an outlined Stop and the filled send). And the filled square looked the same whether Enter would send, queue or steer.

## Decision

1. **Each button says what it does and the key that does the same.** The composer's footer ends in **Send ↵** (or **Queue ↵** while a turn runs), **Steer ⌘↵** and **Stop ⇧⌘S**; on Windows and Linux the keys read Enter, Ctrl+Enter and Ctrl+Shift+S. The key is drawn as a key cap. Each button's accessible name stays its full name (Send prompt, Queue prompt, Steer now, Stop agent) and carries its chord in `aria-keyshortcuts`.
2. **The one filled button is always what Enter does**, in the pill pair, `--tt-pill` with `--tt-pill-ink`: the theme's text colour with its canvas as the ink. Every theme keeps that pair far apart, the theme test already holds it in every bundled palette, and an imported theme that leaves roles out keeps the pair it falls back to. Stop is the filled button while nothing is typed; once there is something to queue, Stop steps back to a flat key and Queue is filled.
3. **Cmd+Enter (Ctrl+Enter) steers** the typed prompt into the running turn where the provider can take a steer, as Steer now does. Anywhere else it does what Enter does, as before. Enter still sends, or queues while a turn runs. It is a fixed chord, listed under Settings › Keyboard, and stands down if one of dictation's shortcuts already means those keys.
4. **A light runs round Stop while a turn runs.** The control that ends the turn is the sign that the turn is running, and it stays on Stop when Stop steps back, so where to look never moves. Only `transform` animates; reduced motion leaves it at rest, and a hidden window pauses it. Stop stays a soft square; the light is the status, which ADR-0110 lets move.
5. **A narrow pane shows the keys alone.** Below 600px of pane, as the 820px window leaves with the sidebar open, and in the slim composer, a button with a key cap drops its word. A button with no key keeps its word (Stop in Watcher, where the stop chord does not answer; Steer where dictation holds Cmd+Enter).
6. **The follow-up editor follows**: **Cancel Esc** and **Save ↵**, and its hint says only that Shift+Enter adds a line.

The buttons keep their order (Steer, Stop, then the filled button), so a turn's Stop does not move when the user starts typing. The queue's own **Steer now** stays in words: a row has no key of its own. The paired phone's composer is native and keeps its look.

## Consequences

- `--threads-on-accent` is gone. Nothing pairs `--tt-on-accent` with anything but `--tt-accent` now.
- `threadChordCap` in `src/renderer/src/agents/threadShortcuts.ts` draws a chord as a key cap; a new key cap uses it rather than spelling keys out.
- The ten directions that were not picked, and the three ways of showing a running turn, stay at the tag `prototype/prompt-send-stop`.
