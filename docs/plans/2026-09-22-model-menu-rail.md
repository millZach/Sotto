# Hold the model menu's providers on a rail of marks

Branch: `feat/thread-ui-fixes`. Mock-up: `docs/prototypes/model-menu-two-column-prototype.html`.

## What was asked

The model menu put its providers in tabs across the top of a 300px menu, and a fourth provider had nowhere
to go: "Devin" was clipped. Zach asked for two columns instead, a narrow left column carrying only each
provider's logo and a searchable model list on the right, used everywhere the model picker appears.

## What was chosen

The mock-up offered three variants, all with a 52px rail of logos:

- **a, Icon rail.** A search line over a flat list of the chosen provider's models. 336px.
- **b, Search first.** "All" above the providers, so the search crosses every provider at once.
- **c, Described rows.** Two lines a model, with the thread's current model pinned above the list.

Zach chose **a**, on September 22, 2026, after opening the mock-up in Sotto's browser. It is the smallest of
the three and the closest to the menu it replaces, less the clipped tabs.

## How it was built

The rail is one tab stop: arrow keys move along it, and the tile they land on becomes the list, so the
keyboard path is the rail, then the search line, then the list. Each tile's name is its accessible name and
its tooltip. A thread that has sent keeps a single column, because it has only one provider to show. The
composer chip and the full-width field in New thread and New terminal keep their triggers; both open this
menu. `CONTEXT.md` describes it under **Option chips**.
