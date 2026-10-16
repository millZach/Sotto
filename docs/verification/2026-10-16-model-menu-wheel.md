# The mouse wheel on the model menu's provider rail — 2026-10-16

Zach asked for the wheel to step through providers in the model menu, the way it already steps the effort chip (#1085). This note records what the built app does and how that was checked.

## What Sotto does now

Each turn of the wheel over the rail of provider marks steps one provider: down to the next, up to the previous, stopping at either end. A turn ends when the wheel rests for 150 milliseconds or turns the other way, so a mouse notch is one step, notches turned quickly together are one step, and a touchpad swipe with its momentum is one step once its small movements add up to 40 pixels. Ctrl or Command with the wheel, a pinch and sideways scrolling keep their own meaning over the rail, and the chosen provider is brought into view on a rail taller than the menu. The search line keeps focus, so typing goes on in the newly chosen provider's models. When focus is on the rail itself, it moves with the choice. Nothing is chosen until a model is, and the wheel over the model list still scrolls the list.

## How it was checked

`tests/e2e/model-menu-wheel.spec.ts` launches the app built from the branch in the `design-threads-empty` scenario, whose host offers Claude, Codex and Grok. It opens **Settings → Agents → New threads start with**, moves the pointer over the rail, and turns a real Chromium wheel through Playwright. One notch moved the menu from Claude to Codex: the Codex tile is filled, the search line reads "Search Codex models" with the caret still in it, and the list shows GPT-5.4. A notch back returned to Claude, three notches turned quickly together stepped once, and notches with pauses between them stopped on the last provider. The marks show as letters because the scenario's test models carry no provider IDs.

- Before: [before.png](../../artifacts/model-menu-wheel/before.png)
- After one notch: [after-one-notch.png](../../artifacts/model-menu-wheel/after-one-notch.png)

The unit tests in `tests/unit/renderer/modelPicker.test.tsx` cover what the built app cannot show deterministically: a touchpad swipe and its momentum stepping once, a turn the other way starting at once, a turn kept when the owner hands over a fresh list of the same models, two turns that land before the menu redraws both counting, a reopened menu starting afresh, zoom and sideways scrolling left alone, the chosen tile scrolled into view, and focus moving with the choice on the rail. Each of those failed before the change that makes it pass, except a turn the other way, which the earlier code already did.

Not checked: the installed Owl and stable builds, which carry the change only once it is merged and released, and a Mac trackpad or mouse.
