# Zach's composer and Drake's pill, chosen in Appearance

October 30, 2026, on forge (Linux), in the built app under Playwright and a virtual display. Issue #1919, ADR-0168.

## What was run

`tests/e2e/composer-style.spec.ts` on the `composer-speed` fixture scenario, where the test Claude model offers a Fast speed so the bolt is drawn. Workshop is at rest with Full access and High effort. Docs is mid-turn, its reply streaming. Both have sixteen messages behind the composer. The spec checks each style at 1280x800 and at the 820x560 minimum, in dark and light. In every capture nothing spills sideways, the footer stays inside the card and the card's border is transparent. In Zach's composer the prompt also sits above the footer and takes more than 85% of the card's width.

## What it showed

- **Zach's composer is the default.** `form.thread-prompt` carries `data-style="rows"` with no setting saved. The prompt has the card's width; under it, attach sits on the left and the permissions, the model with its effort, the bolt and the disc sit on the right (`rows-idle-1280-dark.png`, `rows-idle-1280-light.png`).
- **Permissions in words, shield alone when narrow.** At 1280 the footer reads "Full access" in gold beside the shield; at 820 the shield alone (`rows-idle-820-dark.png`, `rows-idle-820-light.png`).
- **The bolt.** It is drawn after the effort word for a model that offers Fast, as an outline at Standard.
- **Stop drawn once.** While Docs works with nothing typed, the actions row holds only the disc, named Stop agent (`rows-working-1280-dark.png`, `rows-working-1280-light.png`). Typed, it holds Stop agent and then Queue prompt (`rows-working-typed-1280-dark.png`, `rows-working-typed-820-light.png`).
- **Drake's composer is unchanged.** Saving `composerStyle: 'pill'` redraws the same thread as the one pill of ADR-0161, with the shield at its start, the split chip, Stop and the disc (`pill-working-typed-1280-dark.png`, `pill-idle-820-dark.png`).
- **The choice.** Settings › Appearance › Composer shows two cards, each with a sketch. The one in use is marked "In use" (`appearance-choice-dark.png`, `appearance-choice-light.png`). Pressing Zach's composer there saved `composerStyle: 'rows'`.

The Queue disc's download-arrow glyph in these captures belongs to the pill's parts; #1911 replaces it in both styles.

## Not checked here

- Windows and macOS captures, and the design baselines that change with the default composer and the new Appearance card. They are regenerated on the Windows laptop.
- The slim composer while reading back in Zach's composer (`composer-shrink.spec.ts` ran on the pill only).
