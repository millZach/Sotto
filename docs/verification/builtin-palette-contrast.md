# The built-in palettes' text at 4.5:1

October 11, 2026. Closes [#936](https://github.com/millZach/Sotto/issues/936), the built-in half of the gaps the Omarchy work found ([#935](https://github.com/millZach/Sotto/pull/935), `docs/verification/omarchy-muted-surfaces.md`). Base: `5a8d818d` on `origin/main`. Branch: `fix/builtin-palette-contrast`. Zach agreed on October 11 to change how Windows and macOS look to fix it. ADR-0024 is amended.

The before-and-after page is `docs/prototypes/builtin-palette-contrast-prototype.html`. It shows every half, each panel captured in the running app before and after, with the app's own pixel readings under each capture.

## Which pairs count

The issue's table measured muted text on 35 surfaces. Some of those carry no muted text: nothing muted sits on the update surface (only the update chip's own ink does, at 6.22:1 or better), and the `sidebarRowActive` role paints only Settings' current section, in body text. The ink on the user's bubble is secondary text, not body text, because `.thread-message__text` is never rendered.

Following every `color:` that paints text back to the background behind it, states included, turned up more pairs below 4.5:1 than the issue listed:

- amber, green and red status text in the light halves (file badges, branch problems, notes, "Updated", "Copied", code strings and the − sign);
- a hovered link in the bubble and on the selection;
- code keywords, which use the primary action's fill as ink;
- faint ghost buttons on menus, sunken cards and glass, and on two tinted cards (the bubble's Dismiss and the theme-import warning);
- amber on the current row (needs you, disconnected, a branch problem) and on a failed send's status in the bubble;
- red on a selected browser tab whose page is unavailable, and on a link that would not open, in the bubble.

Icons need 3:1, and disabled controls are exempt. The two-axis review found the needs-you status, the failed send and the failed link. Those three reach their ink through local aliases (`--threads-warning-text`) or the raw `--tt-error` token, which the first audit's search for `color:` reading a `--tt-*` token did not follow. A second sweep followed every alias. Greptile's review then found "Copied" in the bubble, which the darker green had already lifted to 4.57:1. The green moved a further 0.005 to reach the same 4.6:1 as every other fix, and the pair is now listed.

`tests/fixtures/renderer/paintedTextPairs.ts` lists the pairs: 173 of them, each an ink, a surface and the translucent layers over it. The Changes tints (now `--changes-added` and `--changes-removed`), the selection wash, the follow-ups surface and the stylesheets' own mixes are read from the stylesheets that declare them. `themeTokens.test.ts` holds every built-in half to the list, and `omarchyThemes.test.ts` holds all 22 stock Omarchy palettes to it as well. Contrast is computed the way the Omarchy audit models it: each wash is composited fractionally over the tint beneath, and the lower of that and the rounded sRGB pixel counts. Against `main`'s palettes, the new test fails 11 of the 12 halves.

## How each pair was fixed

Each palette fix moves one role's OKLCH lightness and nothing else, only in a half where one of that role's pairs was below 4.5:1, and only until every such pair reads at 4.6:1. The extra tenth covers the difference between computed and painted colour: Chromium measured 3.99:1 where the tokens say 4.04:1.

- **Muted text, dark halves:** `mutedForeground` rises. That alone would have taken Hush to Sotto's own 0.72, so it rises only as far as the current row, a highlighted choice and hovered Changes lines need.
- **The bubble, dark halves:** `messageSurface` drops 0.018 to 0.027 so its time reads at 4.5:1. The bubble still sits a clear step above the room.
- **Faint text:** `placeholder` moves about 0.01 to 0.02 so ghost buttons and placeholders read on menus, sunken cards and glass. On the bubble and the theme-import warning card, the ghost buttons take muted ink instead, as the Changes comment's and New thread's already do. Faint ink could only reach 4.5:1 there by becoming as strong as muted text.
- **Amber, light halves:** `warningForeground` darkens 0.016 to 0.041.
- **Red:** `errorForeground` darkens in five light halves and lifts in four dark ones, by 0.007 to 0.029.
- **Status on a tint:** the selection and the bubble are tints, and status text on them would have pulled amber a further 0.02 darker and dark red toward pink. Two tokens in `tokens.css` take it instead. `--tt-warning-on-tint` mixes amber a tenth toward the body ink, for needs you, disconnected and a branch problem on the current row and for a failed send's status in the bubble. `--tt-error-on-tint` mixes red a fifth toward it, for a selected unavailable browser tab and for a link that would not open, in the bubble.
- **Link hover:** `messageActionHover` darkens in four light halves and lifts a hair in Tropic dark. It is also the primary button's hover fill, which only gains contrast.
- **Green, light mode:** the `--tt-success` constant in `tokens.css` darkens from L 0.50 to 0.445. The plain + sign then reads on added lines and Copied in the bubble, and the finished ring only gains. Omarchy sets its own green at load and is unaffected.
- **Picked Changes lines:** the 22% selection wash stays, because a lighter wash made a picked line almost indistinguishable from a hovered one (1.01:1 between them in Tropic dark at 16%). A picked line's numbers take the body ink instead, as a pointed-at number already does. Its signs keep 70% green and 40% red, mixed toward that ink in OKLab. An sRGB mix of green and white can be darker than both, which is how Tokyo Night fell short of 4.5:1.
- **Code keywords:** they mix the primary fill 85% toward the body ink (`rich-messages.css`). The fill was tuned for its button, so the fix belongs where it is used as text. This also lifts seven stock Omarchy palettes whose keywords read at 4.06 to 4.44:1, without changing the Omarchy guard.

Sotto dark needs no palette change. Sotto light changes only `placeholder`, `warningForeground` and the light green, and the first-paint copy in `tokens.css` follows. The iPhone's generated palettes (`apps/ios/Sotto/ThemePalettes.swift`, ADR-0051) were regenerated for the new `placeholder` and dark `messageSurface`. Its derived inks did not change.

### Every changed role

#### `mutedForeground`

| Half | Before | After |
| --- | --- | --- |
| Hush dark | `oklch(0.653373 0.008237 164.809)` | `oklch(0.695373 0.008237 164.809)` |
| Linen dark | `oklch(0.655318 0.01517 76.002)` | `oklch(0.694318 0.01517 76.002)` |
| Nocturne dark | `oklch(0.637809 0.01518 258.359)` | `oklch(0.669809 0.01518 258.359)` |
| Tropic dark | `oklch(0.645106 0.037601 3.718)` | `oklch(0.675106 0.037601 3.718)` |
| Citrine dark | `oklch(0.625022 0.041622 95.87)` | `oklch(0.647022 0.041622 95.87)` |

#### `messageSurface`

| Half | Before | After |
| --- | --- | --- |
| Hush dark | `oklch(0.379569 0.014671 162.94)` | `oklch(0.359569 0.014671 162.94)` |
| Linen dark | `oklch(0.379746 0.029579 77.118)` | `oklch(0.360746 0.029579 77.118)` |
| Nocturne dark | `oklch(0.359462 0.025568 253.974)` | `oklch(0.341462 0.025568 253.974)` |
| Tropic dark | `oklch(0.354797 0.047752 160)` | `oklch(0.327797 0.047752 160)` |
| Citrine dark | `oklch(0.341787 0.02119 96.512)` | `oklch(0.321787 0.02119 96.512)` |

#### `placeholder`

| Half | Before | After |
| --- | --- | --- |
| Sotto light | `oklch(0.535 0.015 78)` | `oklch(0.525 0.015 78)` |
| Hush light | `oklch(0.5017 0.006979 164.774)` | `oklch(0.4817 0.006979 164.774)` |
| Hush dark | `oklch(0.64738 0.007788 162.634)` | `oklch(0.66638 0.007788 162.634)` |
| Linen light | `oklch(0.496687 0.009315 69.904)` | `oklch(0.478687 0.009315 69.904)` |
| Linen dark | `oklch(0.647699 0.012258 73.997)` | `oklch(0.668699 0.012258 73.997)` |
| Nocturne light | `oklch(0.496988 0.013383 249.646)` | `oklch(0.479988 0.013383 249.646)` |
| Nocturne dark | `oklch(0.631529 0.012065 256.751)` | `oklch(0.650529 0.012065 256.751)` |
| Tropic light | `oklch(0.500998 0.036767 3.456)` | `oklch(0.490998 0.036767 3.456)` |
| Tropic dark | `oklch(0.632861 0.029417 5.006)` | `oklch(0.654861 0.029417 5.006)` |
| Citrine light | `oklch(0.507797 0.026421 92.312)` | `oklch(0.490797 0.026421 92.312)` |
| Citrine dark | `oklch(0.618009 0.03531 96.564)` | `oklch(0.637009 0.03531 96.564)` |

#### `warningForeground`

| Half | Before | After |
| --- | --- | --- |
| Sotto light | `oklch(0.546927 0.155556 45.359)` | `oklch(0.530927 0.155556 45.359)` |
| Hush light | `oklch(0.540112 0.153623 45.359)` | `oklch(0.501112 0.153623 45.359)` |
| Linen light | `oklch(0.535178 0.152223 45.359)` | `oklch(0.495178 0.152223 45.359)` |
| Nocturne light | `oklch(0.535178 0.152223 45.359)` | `oklch(0.497178 0.152223 45.359)` |
| Tropic light | `oklch(0.540112 0.153623 45.359)` | `oklch(0.499112 0.153623 45.359)` |
| Citrine light | `oklch(0.545036 0.155019 45.359)` | `oklch(0.508036 0.155019 45.359)` |

#### `errorForeground`

| Half | Before | After |
| --- | --- | --- |
| Hush light | `oklch(0.509494 0.208583 28.513)` | `oklch(0.484494 0.208583 28.513)` |
| Hush dark | `oklch(0.702184 0.189226 22.228)` | `oklch(0.731184 0.189226 22.228)` |
| Linen light | `oklch(0.509494 0.208583 28.513)` | `oklch(0.480494 0.208583 28.513)` |
| Linen dark | `oklch(0.702184 0.189226 22.228)` | `oklch(0.731184 0.189226 22.228)` |
| Nocturne light | `oklch(0.509494 0.208583 28.513)` | `oklch(0.480494 0.208583 28.513)` |
| Nocturne dark | `oklch(0.702184 0.189226 22.228)` | `oklch(0.712184 0.189226 22.228)` |
| Tropic light | `oklch(0.509494 0.208583 28.513)` | `oklch(0.486494 0.208583 28.513)` |
| Tropic dark | `oklch(0.702184 0.189226 22.228)` | `oklch(0.709184 0.189226 22.228)` |
| Citrine light | `oklch(0.509494 0.208583 28.513)` | `oklch(0.492494 0.208583 28.513)` |

#### `messageActionHover`

| Half | Before | After |
| --- | --- | --- |
| Hush light | `oklch(0.501932 0.0278 162.302)` | `oklch(0.462932 0.0278 162.302)` |
| Linen light | `oklch(0.509263 0.044106 71.67)` | `oklch(0.460263 0.044106 71.67)` |
| Tropic light | `oklch(0.531301 0.201531 5.62)` | `oklch(0.487301 0.201531 5.62)` |
| Tropic dark | `oklch(0.72778 0.176858 5.966)` | `oklch(0.73478 0.176858 5.966)` |
| Citrine light | `oklch(0.552021 0.112909 91.871)` | `oklch(0.473021 0.112909 91.871)` |

#### Stylesheets

| What | Before | After |
| --- | --- | --- |
| `--tt-success`, light (`tokens.css`) | `oklch(0.5 0.11 158)` | `oklch(0.445 0.11 158)` |
| Picked line numbers (`changes.css`) | `--tt-text-muted` | `--tt-text` |
| Picked + sign (`--changes-picked-add`) | `--tt-success` | `color-mix(in oklab, var(--tt-success) 70%, var(--tt-text))` |
| Picked − sign (`--changes-picked-remove`) | `--tt-error-text` | `color-mix(in oklab, var(--tt-error-text) 40%, var(--tt-text))` |
| Amber on a tint (`--tt-warning-on-tint`): the current row's needs you, disconnected and branch problem; a failed send in the bubble | `--tt-warning-text` | `color-mix(in oklab, var(--tt-warning-text) 90%, var(--tt-text))` |
| Red on a tint (`--tt-error-on-tint`): a selected unavailable tab; a link that would not open, in the bubble | `--tt-error-text`, `--tt-error` | `color-mix(in oklab, var(--tt-error-text) 80%, var(--tt-text))` |
| Code keywords (`--rich-code-keyword`) | `--tt-primary` | `color-mix(in oklab, var(--tt-primary) 85%, var(--tt-text))` |
| Ghost buttons on the bubble and the theme-import warning | `--tt-text-faint` | `--tt-text-muted` |

## Lowest reading across the twelve halves

Computed from the tokens, at the default Contrast 100% and Glass 80%, without frost.

| Pair | Before | After |
| --- | ---: | ---: |
| Selected sidebar row: timestamp | 4.04:1 (Hush dark) | 4.60:1 (Hush dark) |
| Message bubble: timestamp | 3.73:1 (Hush dark) | 4.60:1 (Hush dark) |
| Message bubble: Dismiss | 3.05:1 (Hush dark) | 4.60:1 (Hush dark) |
| Strong hover: subtitle and tag | 4.22:1 (Linen dark) | 4.79:1 (Linen dark) |
| Update chip text | 6.22:1 (Sotto light) | 6.22:1 (Sotto light) |
| Muted text on the update surface (not painted) | 4.07:1 (Hush dark) | 4.59:1 (Tropic dark) |
| Changes, picked context line: number | 3.43:1 (Citrine dark) | 8.48:1 (Linen dark) |
| Changes, picked added line: number | 2.71:1 (Citrine dark) | 6.81:1 (Linen dark) |
| Changes, picked removed line: number | 2.91:1 (Citrine dark) | 7.11:1 (Linen dark) |
| Changes, picked added line: + sign | 2.78:1 (Tropic light) | 4.87:1 (Tropic light) |
| Changes, picked removed line: − sign | 2.91:1 (Linen dark) | 5.25:1 (Citrine dark) |
| Changes, hovered added line: number | 4.32:1 (Linen dark) | 4.87:1 (Citrine dark) |
| Changes, hovered removed line: number | 4.44:1 (Linen dark) | 4.80:1 (Nocturne light) |
| Changes, added line: + sign | 3.82:1 (Linen light) | 4.76:1 (Linen light) |
| Changes, removed line: − sign | 4.10:1 (Linen light) | 4.60:1 (Sotto light) |
| Green text: file badge, done, updated | 3.95:1 (Linen light) | 5.01:1 (Linen light) |
| Green Copied, in the bubble and on a hovered reply | 3.65:1 (Linen light) | 4.63:1 (Linen light) |
| Amber text: badges, notes, code strings | 3.90:1 (Tropic light) | 4.60:1 (Sotto light) |
| Amber on the current row: needs you, branch problem | 3.52:1 (Tropic light) | 4.67:1 (Sotto light) |
| Amber status of a failed send, in the bubble | 3.52:1 (Tropic light) | 4.71:1 (Tropic light) |
| Red text on a hovered menu row | 4.15:1 (Hush dark) | 4.60:1 (Tropic dark) |
| Red name of a selected unavailable tab | 3.72:1 (Hush dark) | 4.76:1 (Sotto dark) |
| Red “could not open” under a link in the bubble | 3.43:1 (Hush dark) | 4.99:1 (Hush dark) |
| Link hover and code types | 3.29:1 (Citrine light) | 4.60:1 (Tropic light) |
| Code keywords | 4.01:1 (Citrine light) | 5.02:1 (Citrine light) |
| Faint ghost buttons on menus, cards, glass | 4.22:1 (Linen dark) | 4.60:1 (Tropic light) |
| Ghost buttons on the warning card | 3.88:1 (Citrine dark) | 5.22:1 (Citrine dark) |

Non-text contrast holds. The finished ring, focus ring, control boundary, activity and attention marks keep their 3:1 checks, and the picked line keeps its accent edge and wash. The light green, amber and red only darken against light surfaces, and the dark red only lightens against dark ones.

## Running-app proof

`tools/capture-builtin-palette-contrast.mjs` runs `tests/e2e/builtin-palette-contrast.spec.ts` on the built Electron 43.1.0 app, once on `main`'s build and once on this branch's. The live session tiles an owned nested Hyprland (A, through `scripts/with-nested-hyprland.mjs`) at whatever size its layout allows, which was 941×508 this time, below Sotto's minimum window. So a second Hyprland 0.56.2 (B) runs inside A, floated at exactly 1280×1000, and the app runs on B. At that size the sidebar, the thread and the docked Tools panel stand side by side.

B and the app share a private session bus with no service directories, so no portal can activate. Captures are `grim` on B's output. Each capture is retaken until the window and the elements hold still across it. No input, capture or portal reaches the live session. Both runs ended with no owned process left and the live instance's folder untouched.

One stopped run left B's runtime folder behind, because the wrapper's cleanup stops the whole slice before B's own `finally` runs. It was removed by hand, and the tool now records B's folder and removes it afterwards only if it is still B's and B has exited.

For every half, the spec drives the real app:

- it selects the half through settings;
- it captures the current thread row and its neighbours, and the user's bubble;
- it opens Add project and captures the highlighted folder choice with its Git tag;
- it picks every line of a real Git diff in Changes and moves the pointer away, so the selection rather than the hover paints.

Under each capture it reads the painted ink against the composited background: the ancestors' colours plus the row's selection image, as sRGB pixels.

| Reading in the running app | Before, lowest | After, lowest |
| --- | ---: | ---: |
| Current row: time | 3.99:1 (Hush dark) | 4.55:1 (Hush dark) |
| Bubble: time | 3.69:1 (Hush dark) | 4.55:1 (Hush dark) |
| Strong hover: Git tag | 4.17:1 (Hush dark) | 4.74:1 (Citrine dark) |
| Picked context line: number | 3.43:1 (Citrine dark) | 8.50:1 (Linen dark) |
| Picked added line: number | 2.71:1 (Citrine dark) | 6.82:1 (Linen dark) |
| Picked added line: + sign | 2.78:1 (Tropic light) | 4.83:1 (Tropic light) |
| Picked removed line: number | 2.91:1 (Citrine dark) | 7.20:1 (Linen dark) |
| Picked removed line: − sign | 2.91:1 (Linen dark) | 5.25:1 (Citrine dark) |

Neither run had a page error. Build SHA-256: `out/main/index.js` `b70deb369a82f532dd35f7f1bfd5c41a61e4c47514e2c5ef947dc75a8a7d1fb3`; the renderer chunk carrying the palettes, `out/renderer/assets/accelerator-1tEXzmO2.js`, `3233f30ab47394a1922a8a446a2403424afc33952a48b3e5416f58c3cd34c40a`; `out/renderer/assets/main-DP2KDOEB.css` `e6c6d67deb5872dabdd1e4c7e7a4e8488ea13bf5ed7895ce9c5a970e829ced26`.

On the same inner display and build, `tests/e2e/omarchy-muted-surfaces.spec.ts`, which now shares its measuring step with the new spec (`tests/e2e/support/paintedPair.ts`), passed in 45 seconds. All 198 Omarchy samples read at 4.5:1 or better, the lowest 4.5163:1 on a picked added line in Kanagawa. All 108 built-in samples now do too, the lowest 4.5493:1 on Hush dark's current row; on `main`, the issue's sample put that at 3.99:1.

Retained in `artifacts/builtin-palette-contrast/` (the page embeds all 96 captures):

- [Hush dark, thread list](../../artifacts/builtin-palette-contrast/hush-dark-sidebar-before.png) and [after](../../artifacts/builtin-palette-contrast/hush-dark-sidebar-after.png)
- [Hush dark, bubble](../../artifacts/builtin-palette-contrast/hush-dark-bubble-before.png) and [after](../../artifacts/builtin-palette-contrast/hush-dark-bubble-after.png)
- [Citrine dark, picked lines](../../artifacts/builtin-palette-contrast/citrine-dark-changes-before.png) and [after](../../artifacts/builtin-palette-contrast/citrine-dark-changes-after.png)
- [Tropic light, picked lines](../../artifacts/builtin-palette-contrast/tropic-light-changes-before.png) and [after](../../artifacts/builtin-palette-contrast/tropic-light-changes-after.png)
- [Browser readings before](../../artifacts/builtin-palette-contrast/browser-before.json), [after](../../artifacts/builtin-palette-contrast/browser-after.json) and the [computed minimums](../../artifacts/builtin-palette-contrast/computed-minimums.json)

## Not covered

The picked line's accent edge, against its own 22% accent wash, reads as low as 2.56:1 on a removed line in Citrine light, against 2.57:1 before: the edge and the wash are both the accent, which did not move, and only the removed line's tint darkened a hair with the light red. The edge marks the selection against the unpicked lines beside it, and the focus ring keeps its 3:1 checks on the room and the surface. Holding the edge to 3:1 against its own wash would mean a darker edge or a lighter wash, a look change this issue did not ask for.

No layout changed. Every new rule sets `color` alone, so the 1600×1000, 1280×800 and 820×560 checks are unchanged. The owner's Windows design capture run covers those sizes.

## Design baselines

The Windows design captures were not regenerated. They are taken on the owner's Windows machine, and `npm run design:verify` will report the built-in themes as changed until Zach runs `npm run design:capture` there.

## Repeat the checks

```sh
mise exec node@24.21.0 -- npx vitest run tests/unit/renderer/themeTokens.test.ts tests/unit/shared/omarchyThemes.test.ts tests/unit/shared/iosPalettes.test.ts
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- node tools/capture-builtin-palette-contrast.mjs /tmp/palette-after   # writes /tmp/palette-after/builtin-palette-contrast/
# Before: build main, copy its out/ into this checkout as out-before/ (so node_modules resolves),
# pass out-before/main/index.js as the second argument, then remove out-before/.
```
