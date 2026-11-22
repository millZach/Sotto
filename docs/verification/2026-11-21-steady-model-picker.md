# The composer’s model picker keeps its size across providers

In the built Mac app, switching from Claude’s expanded model card to the Codex tab used to shrink the picker from 390 to 312 CSS pixels. The provider tabs moved with its top edge.

The Electron journey in `tests/e2e/combined-model-effort-picker.spec.ts` now compares the position, width and height of both the dialog and its provider strip after each click on Codex, Favorites and Claude. Both rectangles stayed identical at 1600×1000, 1280×800 and 820×560 in light and dark themes with reduced motion on. The picker stayed inside the window at each size.

The two captures show the same open picker at 1280×800. [Claude’s expanded card](../../artifacts/combined-model-effort-picker/combined-dark-1280.png) · [Codex tab](../../artifacts/combined-model-effort-picker/combined-codex-dark-1280.png)

A separate check used the OpenCode fixture in a new thread. Scrolling its 14-model OpenRouter list brought the last model into view. The dialog and provider strip kept their bounds through the scroll and the switch to Favorites.
