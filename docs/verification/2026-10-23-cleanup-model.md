# Choosing the cleanup model, October 23, 2026

Settings → Cleanup gained **Cleanup model** and **Mode** under the OpenRouter key, as the Owl feature `cleanup-model` ([ADR-0122](../adr/0122-the-cleanup-model-can-be-chosen-on-owl.md)). Checked on an Apple silicon Mac in the built app, in unit tests, and with a few small live OpenRouter requests.

## What was checked

- **The fields in the built app.** `tests/e2e/cleanup-model.spec.ts`, with the feature on: Cleanup model shows Default, the list opens on a click with Default first and the E2E bridge's three models, typing narrows it, Enter saves `llmModel` and the box then shows the model's name, Floor saves `llmMode`, and Escape closes the list without leaving Settings. A second run with the feature off shows the key field and neither new control.
- **Screenshots** with the list open: dark and light at 1280x800 (`artifacts/cleanup-model/cleanup-model-1280x800-dark.png`, `artifacts/cleanup-model/cleanup-model-1280x800-light.png`) and dark at the 820x560 minimum (`artifacts/cleanup-model/cleanup-model-820x560-dark.png`). The list floats over the rows below it; nothing clips at the minimum.
- **Live OpenRouter, October 23.** The models list answered 468 text models on one page (`links.next` null). On a real key, with `reasoning: { effort: 'low' }` and a 40-token cap: `tencent/hy-mt2-1.8b`, a model that lists no reasoning parameter, answered 200 in 911 ms, and 820 ms with `:nitro`; `anthropic/claude-haiku-5.5:nitro` answered 200 in 640 ms and `:floor` 200 in 624 ms. Three `:free` models answered 404 with and without `:nitro` or `:floor`, because that key's OpenRouter privacy settings exclude free endpoints, so whether a mode stacks on `:free` was not shown; such a pick falls back to Mercury 2.
- **The done check.** Muse's review found seven things. Fixed: a slug already ending in `:nitro` or `:floor` has it replaced rather than stacked; the list is read only when the box opens by click, arrow or typing, never on focus; the first character typed into a closed box is kept; the active row scrolls into view and the list is at most 45% of the window high; a next link must be OpenRouter's own models path; a list cut short at the page limit never calls the saved model gone; polish diagnostics record the first model sent. Not changed: the list is not filtered by capability beyond OpenRouter's own text-only default, since OpenRouter drops parameters a model does not take (shown live above); a chosen model that keeps failing still costs its share of the deadline on each dictation before Mercury 2, which the diagnostics now show.
- **The plan.** Muse checked it before it was built. From its findings: a chosen model runs at low effort, which every model accepts; main never registers the list call while the feature is off; the list is read only when the box opens; Settings says when OpenRouter no longer lists the saved model; the bridge fixtures and the README, guide and CONTEXT entries were updated.

## Covered by unit tests

`tests/unit/main/transcriptPolishService.test.ts`: the saved model and mode ignored while the feature is off; a chosen model sent at low effort with `:nitro`; Floor on the default model, and Mercury 2 sent unsuffixed after a 404. `tests/unit/main/openRouterModels.test.ts`: every page read, bad slugs and duplicates dropped, names sorted, no key sent, a next link off OpenRouter never followed, and the failure reasons. `tests/unit/renderer/features/settings/cleanupModelFields.test.tsx`: matching, the lazy read, keyboard pick and Escape, the mode, the missing-model and failure notices, and the fields absent from Settings without the feature. `tests/unit/shared/settings.test.ts` and `owlFeatures.test.ts`: the two settings and the feature.

## Not covered

- A real cleanup through a chosen model, Nitro or Floor. Floor admits flex endpoints that may queue; if they run past the deadline Mercury 2 cleans up, which the unit tests show for a failed first attempt but not for a real slow host.
- OpenRouter's live model list. The parser was written against its documented shape (`data[].id`, `data[].name`, `links.next`).
- Windows and Linux layouts.
