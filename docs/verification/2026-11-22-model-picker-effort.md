# The model picker holds its position when effort changes

In the built Mac app at 1600×1000, switching from Low to Medium moved the composer’s model chip 22.73 CSS pixels to the left. The open picker stayed at x = 1101.72 and its provider strip stayed at x = 1102.72.

The Electron journey in `tests/e2e/combined-model-effort-picker.spec.ts` compared both rectangles through effort changes and provider switches at 1600×1000, 1280×800 and 820×560 in light and dark themes with reduced motion on.

Clicking the checked model hid its effort and speed controls. Space showed them again with Low still selected. Enter folded them, leaving the check mark and outline visible. After Escape, opening from the effort word restored the card and focused the slider. [Collapsed model at 1280×800](../../artifacts/combined-model-effort-picker/collapsed-dark-1280.png)
