# The composer combines model, effort and speed into one picker

## Status

Accepted November 20, 2026, by Zach Miller's choices across four prototype rounds, ending on **Inline Model Card** (Direction C), **Power Gauge** (Slider 2), and **Prism Ignition** (Effect A) of `docs/prototypes/inline-card-slider-styles-prototype.html`, straight to stable. **Number provisional until merge** (docs/agents/domain.md).

Amends [ADR-0168](0168-zachs-composer-is-two-rows-and-drakes-pill-is-the-other-style.md) and [ADR-0172](0172-zachs-composer-is-the-only-composer-and-its-effort-word-offers-a-level.md): at rest the composer still draws the model name and the effort word with its speed bolt side by side, and pressing either opens one combined picker rather than two separate menus.

## Context

In the composer footer, the model chip opened a two-column model menu with a provider rail on the left, while the effort word beside it opened a second menu listing effort levels over a speed segmented control. Switching a thread's model and adjusting its effort or speed took two visits to two menus, and the flat effort list lost the tactile colourway feel of Sotto's **Effort color** setting.

Standalone model pickers outside the composer (Settings → Threads, Worker roles, Council seats and New thread) choose only a model, so they keep their two-column layout and close on pick.

## Decision

1. **One combined picker, unchanged at rest.** The composer footer keeps the same resting layout: permissions shield, provider mark and model name, effort word with its speed bolt, and optional draft effort suggestion (`→ XHigh` / `→ Ultracode`). Pressing either the model name or the effort word opens the same combined picker dialog. Opening from the model name focuses the search input; opening from the effort word opens straight to the active model's inline card and focuses the effort slider. Closing returns focus to whichever trigger opened it. Direct arrow-key effort stepping and `Alt+Up/Down` speed stepping on the focused effort word stay intact.

2. **Inline Model Card with top provider strip (Direction C).** Connected providers (and Favorites when enabled) sit as a horizontal icon strip below the search line. Inside the model list, the active model expands inline into a card holding its model header, effort gauge and speed switch. When browsing another provider, model source or search that hides the active model, a compact pinned summary bar sits below the provider strip and jumps straight back to the active model on click.

3. **Power Gauge effort slider (Slider 2).** Effort levels inside the active model's inline card are drawn as draggable segmented energy cells in a recessed tray, lit progressively across the chosen **Effort color** gradient (`--tt-effort-fill-image`), with clickable stop labels beneath each cell. Dragging previews smoothly with magnetic stops and commits on release; clicking a cell or stop, using arrow keys, `Home`/`End`, digits `1`–`9` or the mouse wheel steps directly.

4. **Prism Ignition at the highest tier (Effect A).** Reaching a model's highest effort stop from below plays a one-shot arrival effect when motion is allowed: double shockwave rings radiating from the leading cell, a diagonal glass sheen across the inline card, and a letter-by-letter colour cascade on the level word (animating colour alone so Rainbow's clipped gradient never drops out). While at the highest tier, a thin orbiting comet traces the inline card's border, pausing in a hidden window and stopping under reduced motion.

5. **Stay open on model pick.** Choosing a different model inside the combined picker switches the thread immediately and keeps the picker open so the newly selected model expands inline with its own Power Gauge and speed tiers in the same visit. Picking another provider's continuation handover or a Watcher replacement still closes the picker.

6. **Straight to stable.** The combined picker ships directly to stable, with no Owl feature gate.

## Consequences

- Switching model, effort and speed in a thread composer takes one menu visit while keeping the composer's quiet resting bar unchanged.
- Locked effort states (a started Grok Build thread, a Devin model with no effort levels, or a routed thread where Model routing chooses the effort) show their plain-English reason inside the inline card and keep the locked chip at rest.
- Standalone model pickers outside the composer stay unchanged.

## Considered options

- **Footer Dock (Direction A).** Keeps the left provider rail and pins an effort/speed tray below the model list. Rejected in favour of expanding the active model in place so effort and speed visibly belong to that model.
- **Split Deck (Direction B).** Two-column popover with models on the left and effort/speed on the right. Rejected as wider than necessary on narrow 820px windows.
- **Scrub Fill Bar, Machined Fader and Sliding Pill sliders.** Explored alongside Power Gauge in Round 4; Zach chose Power Gauge.
- **Kinetic Sparks and Aurora Veil top-tier effects.** Explored alongside Prism Ignition in Round 3; Zach chose Prism Ignition.
