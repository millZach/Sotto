# OpenCode's model menu on its model sources: what was checked

October 16, 2026. Issue #1105, [ADR-0087](../adr/0087-opencode-is-a-thread-provider.md), variant C of the model menu prototype. Built on the OpenCode adapter as it stands in #1126.

## Unit

`tests/unit/renderer/modelPicker.test.tsx` gained nine tests for a provider whose models name a model source. Eight failed against the menu before this change, and the ninth, a provider without sources left as it was, passed both before and after. Together they cover:

- The menu opens on the sources: OpenCode Zen first with **Free with OpenCode Zen**, each with its model count, and the source holding the thread's model marked.
- Choosing a source shows its models newest first, under **Model sources** (accessible name "Back to model sources") and the count. Focus lands on the thread's model, or on the first model.
- The back control returns to the sources with focus on the row it left.
- Typing searches every source at once under source headings, with a count. A source's name finds all its models.
- Down from search enters the sources, the arrows, Home and End move, and Enter opens a source and picks a model.
- Escape clears the search, then leaves the source with focus on its row, then closes with focus on the chip.
- The rail and the wheel move away and back to the provider, which starts again on its sources.
- The chip: the OpenCode mark, "Anthropic/Claude Sonnet 5" in text, and "Claude Sonnet 5 from Anthropic, in OpenCode" as its tooltip and accessible description.
- A provider without sources is unchanged: one list, today's placeholder, and Escape left to the dialog.

## Running desktop

Built with `npm run build`, then driven on Windows with `npx playwright test tests/e2e/opencode-model-menu.spec.ts`. The scripted OpenCode server (`tests/fixtures/fakeOpenCodeServer.mjs`) lists four model sources through its `script.json`: OpenCode Zen (4 models), Anthropic (4), OpenAI (3) and OpenRouter (14, enough to scroll). It runs in an owned fresh profile with Owl's OpenCode feature on.

- From the keyboard: the chip opens the menu on the sources with focus in search. Down and Enter open Anthropic with focus on Claude Sonnet 5. Escape returns to Anthropic's row and a second Escape returns to the chip. A search from inside OpenRouter shows both sources' Claude models under their headings. Escape clears it, Escape leaves OpenRouter, and Escape closes. Escape is taken before the dialog closes on it, so each press goes back exactly one step.
- The wheel over the rail steps to the next provider and back, and OpenCode starts on its sources again.
- Choosing GPT-6-Luna from OpenAI by keyboard puts "OpenAI/GPT-6-Luna" on the chip.
- Light and dark at 1600x1000, 1280x800 and 820x560 with reduced motion: the sources, OpenRouter's models and a search across sources. At every size the menu stays inside the window and off the chip, no text in it is cut off, and the note under the list stays in view.
- Lowest contrast by appearance (`contrast.json`; 4.5:1 needed):

  | Text | Dark | Light |
  |---|---|---|
  | Source name | 11.71:1 | 9.42:1 |
  | Chosen source, accent | 10.77:1 | 6.52:1 |
  | Count | 8.17:1 | 6.06:1 |
  | Header count | 8.17:1 | 6.06:1 |
  | Source heading | 8.17:1 | 6.06:1 |
  | Chip's source | 9.20:1 | 6.95:1 |
- "OpenCode Zen / Nemotron 3.5 Super VL Free" at 820x560: the source gives way, staying at least 4.5em, and the model's name stays whole.
- With motion on, the menu rises as it opens and settles in place. With reduced motion it has no animation.

Captures: [sources, 1600 dark](../../artifacts/opencode-model-menu/sources-1600-dark.png), [sources, 820 light](../../artifacts/opencode-model-menu/sources-820-light.png), [OpenRouter, 1280 light](../../artifacts/opencode-model-menu/openrouter-1280-light.png), [search across sources, 820 dark](../../artifacts/opencode-model-menu/search-820-dark.png), [long name on the chip, 820 dark](../../artifacts/opencode-model-menu/chip-long-name-820-dark.png), [sources with motion, 1280 dark](../../artifacts/opencode-model-menu/sources-1280-dark-motion.png).

`model-menu-wheel`, `long-context-model` and `new-thread-settings` pass on the same build.

## Found while looking, and fixed

These touch every provider's menu, not only OpenCode's.

- **A long list hid the note under it.** The menu's grid row grew with its content past the menu's height, so the list did not scroll and the note was cut off. The row is now held to the menu's height.
- **The menu could cover its own chip.** When a step changed the menu's height, it kept the position it had for the old height. It is now placed again on every draw, holding the chip's edge: a menu above its chip keeps its foot there and grows and shrinks upward, one below keeps its head there, and it changes sides only when it no longer fits on its own. Where it fits on neither side of the chip, as at 820x560 with the composer mid-way down, it takes the roomier side and is shortened to fit.
- **A 1ms transition held the menu over the chip.** Reduced motion gives every property a 1ms transition, and a window in the background never finished it, so the menu stayed in its old place. The menu now has no transitions; its opening animation is separate and unaffected.

## Not changed

- `npm run design:verify` reports three differences that predate this change: a message bubble's height in `threads-open-running`, and a 1px size difference in `scale-125-onboarding` and `widget-idle-light`. None of these captures shows the model menu or an OpenCode chip, so no baseline was regenerated.
- OpenRouter's list follows `newestModelsFirst`, which compares bare version numbers across companies, so GLM 5.3 sorts above Claude Sonnet 5. The prototype flagged the same.
